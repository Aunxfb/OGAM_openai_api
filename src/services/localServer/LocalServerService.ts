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
import { llmService } from '../llm';
import type { Message } from '../../types';
import logger from '../../utils/logger';
import {
  validateLocalServerConfig,
  startLocalServerNative,
  stopLocalServerNative,
  subscribeLocalServerEvents,
  respondToLocalServerRequest,
  sendLocalServerChunk,
  finishLocalServerStream,
  type LocalServerNativeRequest,
  type LocalServerNativeStatus,
} from './contract';
import type {
  LocalServerCompletionJob,
  LocalServerConfig,
  LocalServerJsonAnswer,
  LocalServerStatus,
} from './types';
import type { LocalServerFinalResponse } from './contract';
import {
  admitOrReject,
  isAuthorizedRequest,
  modelLoadingBody,
  normalizeChatMessages,
  splitSamplingParams,
  parseJsonBody,
  isStreamRequested,
  formatSSEChunk,
  chatChunkEnvelope,
  chatCompletionJson,
  textCompletionJson,
  tokenizeJson,
  detokenizeJson,
  unauthorizedBody,
  notFoundBody,
  embeddingsUnavailableBody,
  modelsListPayload,
  type ChatMessage,
} from './oai';

export type LocalServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface LocalServerBridge {
  startNative: (config: LocalServerConfig) => Promise<LocalServerNativeStatus>;
  stopNative: () => Promise<void>;
  subscribeEvents: (handlers: {
    onStatus?: (status: LocalServerNativeStatus) => void;
    onError?: (message: string) => void;
    onRequest?: (request: LocalServerNativeRequest) => void;
  }) => () => void;
  respond: (requestId: string, response: LocalServerFinalResponse) => Promise<void>;
  sendChunk: (requestId: string, sseData: string) => Promise<void>;
  finishStream: (requestId: string) => Promise<void>;
}

const defaultBridge: LocalServerBridge = {
  startNative: startLocalServerNative,
  stopNative: stopLocalServerNative,
  subscribeEvents: subscribeLocalServerEvents,
  respond: respondToLocalServerRequest,
  sendChunk: sendLocalServerChunk,
  finishStream: finishLocalServerStream,
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

export type TokenizeFn = (text: string) => Promise<number[]>;
export type DetokenizeFn = (tokens: number[]) => Promise<string>;

/** Tokenizer seam: the loaded text context, injectable for tests. */
export interface LocalServerTokenizer {
  tokenize: TokenizeFn;
  detokenize: DetokenizeFn;
}

const defaultTokenizer: LocalServerTokenizer = {
  tokenize: text => llmService.tokenize(text),
  detokenize: tokens => llmService.detokenize(tokens),
};

export class LocalServerService {
  private state: LocalServerState = 'stopped';
  private activeRequests = 0;
  private unsubscribe: (() => void) | null = null;
  private completionSeq = 0;

  constructor(
    private readonly bridge: LocalServerBridge = defaultBridge,
    private readonly generate: GenerateFn = defaultGenerate,
    private readonly tokenizer: LocalServerTokenizer = defaultTokenizer,
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
        onRequest: r => {
          this.handleNativeRequest(r).catch(err =>
            logger.warn(`[LOCAL-SERVER] request ${r.requestId} failed: ${String(err)}`),
          );
        },
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

  /**
   * Answer one native-admitted HTTP request. Always settles exactly once —
   * the socket thread blocks until this answers, so every path (including
   * unexpected throws) ends in a final response or a closed stream.
   */
  async handleNativeRequest(req: LocalServerNativeRequest): Promise<void> {
    try {
      const gated = this.gateRequest(req);
      if (gated) {
        await this.sendJson(req.requestId, gated);
        return;
      }
      const { method, path } = req;
      if (method === 'GET' && path === '/health') {
        await this.sendJson(req.requestId, { status: 200, body: { status: 'ok' } });
        return;
      }
      if (method === 'GET' && path === '/v1/models') {
        await this.sendJson(req.requestId, this.modelsAnswer());
        return;
      }
      if (path === '/v1/embeddings') {
        await this.sendJson(req.requestId, { status: 501, body: embeddingsUnavailableBody() });
        return;
      }
      if (method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/completions')) {
        await this.completionAnswer(req);
        return;
      }
      if (method === 'POST' && (path === '/tokenize' || path === '/detokenize')) {
        await this.codecAnswer(req);
        return;
      }
      await this.sendJson(req.requestId, { status: 404, body: notFoundBody() });
    } catch (err) {
      logger.warn(`[LOCAL-SERVER] request ${req.requestId} error: ${String(err)}`);
      await this.sendJson(req.requestId, { status: 500, body: { error: { message: 'internal error' } } });
    }
  }

  /** Fail-closed gate: 503 when not running, 401 without the key. Null = pass. */
  private gateRequest(req: LocalServerNativeRequest): LocalServerJsonAnswer | null {
    if (this.state !== 'running') {
      return { status: 503, body: modelLoadingBody(), extraHeaders: { 'Retry-After': '5' } };
    }
    if (!this.isAuthorized(req.path, req.headers.authorization ?? null)) {
      return { status: 401, body: unauthorizedBody() };
    }
    return null;
  }

  private sendJson(requestId: string, answer: LocalServerJsonAnswer): Promise<void> {
    return this.bridge.respond(requestId, {
      status: answer.status,
      body: JSON.stringify(answer.body),
      extraHeaders: answer.extraHeaders,
    });
  }

  /** Admit one inference slot, else the 503 answer. Null = admitted. */
  private admitSlot(): LocalServerJsonAnswer | null {
    const admission = admitOrReject(this.activeRequests, useAppStore.getState().localServer.queueDepth);
    if (admission.admitted) return null;
    return {
      status: 503,
      body: modelLoadingBody(),
      extraHeaders: { 'Retry-After': String(admission.retryAfterSec) },
    };
  }

  private loadingAnswer(): LocalServerJsonAnswer {
    return { status: 503, body: modelLoadingBody(), extraHeaders: { 'Retry-After': '5' } };
  }

  private badBodyAnswer(err: unknown): LocalServerJsonAnswer {
    return { status: 400, body: { error: { message: err instanceof Error ? err.message : String(err) } } };
  }

  private modelsAnswer(): LocalServerJsonAnswer {
    const model = this.getModelState();
    if (!model.ready) return this.loadingAnswer();
    return { status: 200, body: modelsListPayload(model.modelId) };
  }

  private async completionAnswer(req: LocalServerNativeRequest): Promise<void> {
    const full = this.admitSlot();
    if (full) {
      await this.sendJson(req.requestId, full);
      return;
    }
    const model = this.getModelState();
    if (!model.ready) {
      await this.sendJson(req.requestId, this.loadingAnswer());
      return;
    }
    let params: Record<string, unknown>;
    try {
      params = parseJsonBody(req.body);
    } catch (err) {
      await this.sendJson(req.requestId, this.badBodyAnswer(err));
      return;
    }
    const job: LocalServerCompletionJob = {
      requestId: req.requestId,
      path: req.path,
      modelId: model.modelId,
      params,
    };
    if (isStreamRequested(params)) {
      await this.streamCompletion(job);
      return;
    }
    await this.singleCompletion(job);
  }

  private async singleCompletion(job: LocalServerCompletionJob): Promise<void> {
    const res = await this.completeChat(job.params.messages, job.params, undefined);
    if (res.status === 200) {
      const envelope =
        job.path === '/v1/chat/completions'
          ? chatCompletionJson({ model: res.model, text: res.text, ...this.nextCompletionIds() })
          : textCompletionJson({ model: res.model, text: res.text, ...this.nextCompletionIds() });
      await this.sendJson(job.requestId, { status: 200, body: envelope });
    } else if (res.status === 503) {
      await this.sendJson(job.requestId, {
        status: 503,
        body: res.body,
        extraHeaders: { 'Retry-After': res.retryAfterSec ? String(res.retryAfterSec) : '5' },
      });
    } else {
      await this.sendJson(job.requestId, { status: 400, body: res.body });
    }
  }

  private async codecAnswer(req: LocalServerNativeRequest): Promise<void> {
    const full = this.admitSlot();
    if (full) {
      await this.sendJson(req.requestId, full);
      return;
    }
    if (!this.getModelState().ready) {
      await this.sendJson(req.requestId, this.loadingAnswer());
      return;
    }
    let params: Record<string, unknown>;
    try {
      params = parseJsonBody(req.body);
    } catch (err) {
      await this.sendJson(req.requestId, this.badBodyAnswer(err));
      return;
    }
    if (req.path === '/tokenize') {
      if (typeof params.content !== 'string') {
        await this.sendJson(req.requestId, {
          status: 400,
          body: { error: { message: 'tokenize requires a string "content" field' } },
        });
        return;
      }
      this.activeRequests += 1;
      try {
        const tokens = await this.tokenizer.tokenize(params.content);
        await this.sendJson(req.requestId, { status: 200, body: tokenizeJson(tokens) });
      } finally {
        this.activeRequests -= 1;
      }
      return;
    }
    if (!Array.isArray(params.tokens) || !params.tokens.every(t => Number.isInteger(t))) {
      await this.sendJson(req.requestId, {
        status: 400,
        body: { error: { message: 'detokenize requires an integer array "tokens" field' } },
      });
      return;
    }
    this.activeRequests += 1;
    try {
      const text = await this.tokenizer.detokenize(params.tokens as number[]);
      await this.sendJson(req.requestId, { status: 200, body: detokenizeJson(text) });
    } finally {
      this.activeRequests -= 1;
    }
  }

  /**
   * SSE completion: one `chat.completion.chunk` per generated token, then the
   * stream closes (native writes `data: [DONE]`). A generation failure still
   * closes the stream — never hangs the socket.
   */
  private async streamCompletion(job: LocalServerCompletionJob): Promise<void> {
    const { requestId, path, modelId, params } = job;
    let parsed: ChatMessage[];
    try {
      parsed = path === '/v1/chat/completions'
        ? normalizeChatMessages(params.messages)
        : [{ role: 'user', content: this.extractPrompt(params) }];
    } catch (err) {
      await this.sendJson(requestId, this.badBodyAnswer(err));
      return;
    }
    const { ignored } = splitSamplingParams(params);
    if (ignored.length > 0) {
      logger.log(`[LOCAL-SERVER] ignoring exotic sampling params: ${ignored.join(',')}`);
    }
    const { id, created } = this.nextCompletionIds();
    this.activeRequests += 1;
    try {
      await this.generate(parsed, async token => {
        const chunk =
          path === '/v1/chat/completions'
            ? chatChunkEnvelope({ model: modelId, delta: token, id, created })
            : { id, object: 'text_completion', created, model: modelId, choices: [{ index: 0, text: token }] };
        await this.bridge.sendChunk(requestId, formatSSEChunk(chunk));
      });
    } catch (err) {
      logger.warn(`[LOCAL-SERVER] stream ${requestId} error: ${String(err)}`);
    } finally {
      this.activeRequests -= 1;
      await this.bridge.finishStream(requestId);
    }
  }

  /** `/v1/completions` takes a plain `prompt` string, not chat messages. */
  private extractPrompt(params: Record<string, unknown>): string {
    if (typeof params.prompt !== 'string' || params.prompt.length === 0) {
      throw new Error('prompt must be a non-empty string');
    }
    return params.prompt;
  }

  private nextCompletionIds(): { id: string; created: number } {
    this.completionSeq += 1;
    return {
      id: `chatcmpl-local-${Date.now()}-${this.completionSeq}`,
      created: Math.floor(Date.now() / 1000),
    };
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
