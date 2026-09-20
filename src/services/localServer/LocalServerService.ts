/**
 * LocalServerService — the SINGLE owner of the on-device llama-server.
 *
 * Owns the server state machine (stopped/starting/running/stopping/error),
 * FIFO admission (depth from config, 503 + Retry-After when full), the Bearer
 * gate (health public), and inference delegation to the active engine via the
 * engine-agnostic `generateStandalone` seam. Screens call intents on this
 * service; the store only mirrors its projection.
 *
 * Never loads/unloads models itself: the served model is always whatever
 * ActiveModelService has loaded (read-only projection). Model transitions
 * answer 503, never silently drop. Additive to existing generation paths —
 * per-request sampler override is v2 (the engine seam has no per-call
 * sampler without mutating global settings, which this service must not do).
 */
import { useAppStore } from '../../stores/appStore';
import { generateStandalone } from '../engines';
import type { Message } from '../../types';
import logger from '../../utils/logger';
import {
  validateLocalServerConfig,
  startLocalServerNative,
  stopLocalServerNative,
  subscribeLocalServerEvents,
  type LocalServerNativeStatus,
} from './contract';
import type { LocalServerConfig, LocalServerStatus } from './types';
import {
  admitOrReject,
  isAuthorizedRequest,
  modelLoadingBody,
  normalizeChatMessages,
  splitSamplingParams,
  type ChatMessage,
} from './oai';

export type LocalServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface LocalServerBridge {
  startNative: (config: LocalServerConfig) => Promise<LocalServerNativeStatus>;
  stopNative: () => Promise<void>;
  subscribeEvents: (handlers: {
    onStatus?: (status: LocalServerNativeStatus) => void;
    onError?: (message: string) => void;
  }) => () => void;
}

const defaultBridge: LocalServerBridge = {
  startNative: startLocalServerNative,
  stopNative: stopLocalServerNative,
  subscribeEvents: subscribeLocalServerEvents,
};

export type GenerateFn = (
  messages: ChatMessage[],
  onToken?: (token: string) => void,
) => Promise<string>;

/** Default delegation: LAN chat turns become engine-agnostic one-shot turns.
 *  Maps the wire shape onto Message (synthetic ids — never written to any
 *  conversation store). */
const defaultGenerate: GenerateFn = (messages, onToken) => {
  const now = Date.now();
  const engineMessages: Message[] = messages.map((m, i) => ({
    id: `local-server-${now}-${i}`,
    role: m.role,
    content: m.content,
    timestamp: now,
  }));
  return generateStandalone(engineMessages, onToken);
};

export class LocalServerService {
  private state: LocalServerState = 'stopped';
  private activeRequests = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly bridge: LocalServerBridge = defaultBridge,
    private readonly generate: GenerateFn = defaultGenerate,
  ) {}

  getState(): LocalServerState {
    return this.state;
  }

  getActiveRequests(): number {
    return this.activeRequests;
  }

  /** Read-only model truth: the loaded text model id, or null in transition.
   *  Reads the store projection (the single source every surface reads for
   *  "currently loaded") — never loads/unloads. */
  getModelState(): { ready: true; modelId: string } | { ready: false } {
    const loadedTextModelId = useAppStore.getState().loadedTextModelId;
    if (!loadedTextModelId) return { ready: false };
    return { ready: true, modelId: loadedTextModelId };
  }

  isAuthorized(path: string, authHeader: string | null): boolean {
    return isAuthorizedRequest(path, authHeader, useAppStore.getState().localServer.apiKey);
  }

  /** Start serving with the persisted config. Fail-closed: bad config or a
   *  native failure (e.g. EADDRINUSE) lands in `error` with a clear message. */
  async start(): Promise<void> {
    if (this.state === 'starting' || this.state === 'running') return;
    const config = useAppStore.getState().localServer;
    try {
      validateLocalServerConfig({ ...config, enabled: true });
    } catch (err) {
      return this.fail(err instanceof Error ? err.message : String(err));
    }
    this.state = 'starting';
    try {
      const status = await this.bridge.startNative({ ...config, enabled: true });
      this.unsubscribe?.();
      this.unsubscribe = this.bridge.subscribeEvents({
        onStatus: s => this.mirrorStatus(s),
        onError: m => this.fail(m),
      });
      this.mirrorStatus(status);
      useAppStore.getState().setLocalServerConfig({ enabled: true });
      this.state = 'running';
      logger.log('[LOCAL-SERVER] started');
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'stopping';
    try {
      await this.bridge.stopNative();
    } catch (err) {
      logger.warn(`[LOCAL-SERVER] stop failed: ${String(err)}`);
    } finally {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.state = 'stopped';
      useAppStore.getState().setLocalServerStatus({ running: false, urls: [] });
      useAppStore.getState().setLocalServerConfig({ enabled: false });
      logger.log('[LOCAL-SERVER] stopped');
    }
  }

  /**
   * Non-streaming chat completion for LAN clients (stream:false path; the
   * native SSE path feeds the same generator per token in T6). Returns a 503
   * body while the model is in transition; rejects over-depth callers with
   * 503 + Retry-After instead of queueing silently.
   */
  async completeChat(
    messages: unknown,
    params: Record<string, unknown>,
    onToken?: (token: string) => void,
  ): Promise<
    | { status: 200; model: string; text: string }
    | { status: 400; body: object }
    | { status: 503; retryAfterSec?: number; body: object }
  > {
    const model = this.getModelState();
    if (!model.ready) return { status: 503, body: modelLoadingBody() };
    const { queueDepth } = useAppStore.getState().localServer;
    const admission = admitOrReject(this.activeRequests, queueDepth);
    if (!admission.admitted) {
      return { status: 503, retryAfterSec: admission.retryAfterSec, body: modelLoadingBody() };
    }
    let parsed: ChatMessage[];
    try {
      parsed = normalizeChatMessages(messages);
    } catch (err) {
      return { status: 400, body: { error: { message: err instanceof Error ? err.message : String(err) } } };
    }
    const { ignored } = splitSamplingParams(params);
    if (ignored.length > 0) {
      logger.log(`[LOCAL-SERVER] ignoring exotic sampling params: ${ignored.join(',')}`);
    }
    this.activeRequests += 1;
    try {
      const text = await this.generate(parsed, onToken);
      return { status: 200, model: model.modelId, text };
    } finally {
      this.activeRequests -= 1;
    }
  }

  private mirrorStatus(s: LocalServerNativeStatus): void {
    const status: LocalServerStatus = {
      running: s.running,
      urls: s.urls,
      requestsServed: s.requestsServed,
      lastError: s.lastError,
    };
    useAppStore.getState().setLocalServerStatus(status);
  }

  private fail(message: string): void {
    this.state = 'error';
    useAppStore.getState().setLocalServerStatus({ running: false, lastError: message });
    logger.warn(`[LOCAL-SERVER] error: ${message}`);
  }
}

export const localServerService = new LocalServerService();
