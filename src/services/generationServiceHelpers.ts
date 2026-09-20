// GenerationService helpers (extracted to keep generationService.ts small). Each receives
// the GenerationService instance as `svc: any` and mutates its internal state.
import { llmService } from './llm';
import { liteRTService } from './litert';
import { getActiveEngineService, prepareActiveConversation } from './engines';
import { useAppStore, useChatStore, useRemoteServerStore } from '../stores';
import type { Message, GenerationMeta, MediaAttachment } from '../types';
import { effectiveCacheType } from './llmHelpers';
import { clearModelFailure } from './modelFailureHandler';
import type { ToolResult } from './tools/types';
import logger from '../utils/logger';
import { activeModelService } from './activeModelService';
import { remoteServerManager } from './remoteServerManager';
import { contextCompactionService } from './contextCompaction';
import {
  buildLiteRTMeta,
  runLiteRTResponseImpl,
} from './generationServiceLiteRT';

export const FLUSH_INTERVAL_MS = 50; // ~20 updates/sec

export type StreamChunk = string | { content?: string; reasoningContent?: string };
export type FallbackRoute =
  | { kind: 'remote'; serverId: string; id: string; name: string }
  | { kind: 'local'; id: string; name: string };

export interface QueuedMessage {
  id: string; conversationId: string; text: string;
  attachments?: MediaAttachment[]; messageText: string;
  /** The modality the user forced for THIS send (force/disabled/auto). Carried through the queue so a
   *  message the user explicitly forced to image mode is dispatched as image on drain â€” never re-decided
   *  at 'auto' by resolveTurnKind (#510: a queued force-image send generated as text). */
  imageMode?: 'auto' | 'force' | 'disabled';
}

/**
 * Keep whatever the user has ALREADY seen when a generation errors mid-stream â€” never discard shown output
 * (device 2026-07-14, the Stop-drops-partial principle extended to the error path, for llama/litert/remote
 * alike). Flush any buffered tokens to the store, then finalizeStreamingMessage: it persists content OR
 * reasoning and resets the streaming state either way (a strict superset of clearStreamingMessage; an empty
 * stream just resets, adding no message). Mirrors GenerationService.keepShownPartialOrClear on the stop path.
 */
export function keepShownPartialOnError(svc: any, conversationId: string): void {
  if (svc.flushTimer) {
    clearTimeout(svc.flushTimer);
    svc.flushTimer = null;
  }
  svc.forceFlushTokens();
  const generationTime = svc.state.startTime
    ? Date.now() - svc.state.startTime
    : undefined;
  useChatStore
    .getState()
    .finalizeStreamingMessage(
      conversationId,
      generationTime,
      buildGenerationMetaImpl(svc),
    );
  svc.resetState();
}

/** Returns true when the currently active model uses LiteRT engine. */
function isLiteRTActive(): boolean {
  return getActiveEngineService() === liteRTService;
}

export interface GenerationRequest {
  conversationId: string;
  messages: Message[];
  onFirstToken?: () => void;
  contextUsage?: Pick<GenerationMeta, 'contextPromptTokens' | 'contextWindowTokens' | 'contextEstimate'>;
  /** A fallback keeps the same in-flight turn and owns its error cleanup. */
  prepared?: boolean;
  preservePartialOnError?: boolean;
}

export interface GenerationWithToolsRequest {
  conversationId: string;
  messages: Message[];
  options: {
    enabledToolIds: string[];
    projectId?: string;
    onToolCallStart?: (name: string, args: Record<string, any>) => void;
    onToolCallComplete?: (name: string, result: ToolResult) => void;
    onFirstToken?: () => void;
    contextUsage?: GenerationRequest['contextUsage'];
    prepared?: boolean;
    preservePartialOnError?: boolean;
  };
}


export function buildGenerationMetaImpl(svc: any): GenerationMeta {
  const meta = buildBaseGenerationMeta(svc);
  if (svc.contextUsage) Object.assign(meta, svc.contextUsage);
  if (!svc.isUsingRemoteProvider() && !isLiteRTActive()) {
    const nativePromptTokens = llmService.getPerformanceStats().lastPromptTokenCount;
    if (nativePromptTokens != null && nativePromptTokens > 0) {
      meta.contextPromptTokens = nativePromptTokens;
      meta.contextEstimate = false;
    }
  }
  const routed = svc.state?.routedToolNames;
  if (Array.isArray(routed) && routed.length > 0) meta.routedToolNames = routed;
  return meta;
}
function buildBaseGenerationMeta(svc: any): GenerationMeta {
  if (svc.isUsingRemoteProvider()) {
    const remoteStore = useRemoteServerStore.getState();
    const activeServer = remoteStore.getActiveServer();
    const activeModel = remoteStore.getActiveRemoteTextModel?.();
    const contentLength =
      svc.state.streamingContent.length + svc.totalReasoningLength;
    const estimatedTokens = Math.ceil(contentLength / 4);
    const generationTime = svc.state.startTime
      ? (Date.now() - svc.state.startTime) / 1000
      : 0;
    const tokensPerSecond =
      generationTime > 0 ? estimatedTokens / generationTime : undefined;
    return {
      gpu: false,
      gpuBackend: 'Remote',
      modelName:
        activeModel?.name ||
        remoteStore.activeRemoteTextModelId ||
        activeServer?.name ||
        'Remote Model',
      tokenCount: estimatedTokens,
      tokensPerSecond,
      timeToFirstToken: svc.remoteTimeToFirstToken,
    };
  }

  const { downloadedModels, activeModelId, settings } = useAppStore.getState();
  const modelName = downloadedModels.find(
    (m: any) => m.id === activeModelId,
  )?.name;

  if (isLiteRTActive()) {
    return buildLiteRTMeta(svc, modelName);
  }

  const { gpu, gpuBackend, gpuLayers } = llmService.getGpuInfo();
  const perf = llmService.getPerformanceStats();
  return {
    gpu,
    gpuBackend,
    gpuLayers,
    modelName,
    tokensPerSecond: perf.lastTokensPerSecond,
    decodeTokensPerSecond: perf.lastDecodeTokensPerSecond,
    timeToFirstToken: perf.lastTimeToFirstToken,
    tokenCount: perf.lastTokenCount,
    cacheType: effectiveCacheType(
      settings.inferenceBackend,
      settings.cacheType,
    ),
    truncated: perf.lastTruncated,
  };
}

function handleStreamChunk(
  svc: any,
  chunk: { content?: string; reasoningContent?: string },
): void {
  if (chunk.content) {
    if (
      !svc.state.streamingContent &&
      svc.remoteTimeToFirstToken === undefined
    ) {
      svc.remoteTimeToFirstToken = svc.state.startTime
        ? (Date.now() - svc.state.startTime) / 1000
        : undefined;
    }
    svc.state.streamingContent += chunk.content;
    svc.tokenBuffer += chunk.content;
  }
  if (chunk.reasoningContent) {
    svc.reasoningBuffer += chunk.reasoningContent;
    svc.totalReasoningLength += chunk.reasoningContent.length;
  }
}

export function buildToolLoopHandlersImpl(svc: any) {
  return {
    isAborted: () => svc.abortRequested,
    onThinkingDone: () => svc.updateState({ isThinking: false }),
    onStream: (data: StreamChunk) => {
      if (svc.abortRequested) return;
      const chunk = typeof data === 'string' ? { content: data } : data;
      handleStreamChunk(svc, chunk);
      if (!svc.flushTimer) {
        svc.flushTimer = setTimeout(
          () => svc.flushTokenBuffer(),
          FLUSH_INTERVAL_MS,
        );
      }
    },
    onStreamReset: () => {
      svc.forceFlushTokens();
      svc.state.streamingContent = '';
      svc.tokenBuffer = '';
      svc.reasoningBuffer = '';
      useChatStore.getState().resetStreamingSegment();
    },
    onFinalResponse: (content: string) => {
      svc.state.streamingContent = content;
      useChatStore.getState().appendToStreamingMessage(content);
    },
    onToolsRouted: (names: string[]) => {
      svc.state.routedToolNames = names;
    },
  };
}

async function checkProviderReadiness(svc: any): Promise<string | null> {
  if (svc.isUsingRemoteProvider()) {
    const provider = svc.getCurrentProvider();
    if (!provider) return 'Remote provider not found';
    const ready = await provider.isReady();
    if (!ready) return 'Remote provider not ready';
  } else if (isLiteRTActive()) {
    if (!liteRTService.isModelLoaded()) return 'No LiteRT model loaded';
  } else {
    if (!llmService.isModelLoaded()) return 'No model loaded';
    // A still-unwinding completion (a stop can only take effect once prefill finishes) is NOT an
    // error â€” wait for the engine to go idle instead of failing the user's send. Only a genuinely
    // stuck/concurrent generation (still busy after the bounded wait) surfaces the busy error.
    if (llmService.isCurrentlyGenerating() && !(await llmService.waitForIdle()))
      return 'LLM service busy';
  }
  return null;
}

export async function prepareGenerationImpl(
  svc: any,
  conversationId: string,
): Promise<boolean> {
  if (svc.state.isGenerating) return false;
  // A NEW attempt owns the text failure surface: clear any card left by a previous failed/stopped
  // attempt at the ONE dispatch seam every path (send/retry/regenerate, local/remote, with/without
  // tools) funnels through â€” a stale card must never sit next to a live stream (device IMG 00:23).
  clearModelFailure('text');
  svc.updateState({
    isGenerating: true,
    isThinking: true,
    conversationId,
    streamingContent: '',
    startTime: Date.now(),
  });
  svc.state.routedToolNames = undefined; // reset so a prior turn's tools don't leak
  useChatStore.getState().startStreaming(conversationId);
  // Drain pending native stop so LLM is idle before we start.
  if (svc.pendingStop !== null) await svc.pendingStop;
  if (!svc.state.isGenerating) return false; // stop called during drain
  svc.abortRequested = false;

  const readinessError = await checkProviderReadiness(svc);
  if (readinessError) {
    svc.resetState();
    useChatStore.getState().clearStreamingMessage();
    throw new Error(readinessError);
  }

  // Navigation effects are not a generation barrier: on a new chat, Send can win
  // that race. Clear/switch native conversation state here, after readiness and
  // before any prompt or tool-routing completion reaches the local engine.
  if (!svc.isUsingRemoteProvider()) {
    await prepareActiveConversation(conversationId);
  }

  svc.tokenBuffer = '';
  svc.reasoningBuffer = '';
  svc.totalReasoningLength = 0;
  svc.remoteTimeToFirstToken = undefined;
  return true;
}


export async function generateResponseImpl(
  svc: any,
  req: GenerationRequest,
): Promise<void> {
  const { conversationId, messages, onFirstToken } = req;
  if (!req.prepared && !(await prepareGenerationImpl(svc, conversationId))) return;
  svc.contextUsage = req.contextUsage;

  if (isLiteRTActive()) {
    return runLiteRTResponseImpl(svc, req);
  }

  const chatStore = useChatStore.getState();
  let firstTokenReceived = false;

  // llama.cpp path â€” unchanged
  try {
    await llmService.generateResponse(messages, {
      onStream: data => {
        if (svc.abortRequested) return;
        const chunk =
          typeof data === 'string'
            ? { content: data, reasoningContent: undefined }
            : data;
        if (!firstTokenReceived) {
          firstTokenReceived = true;
          svc.updateState({ isThinking: false });
          onFirstToken?.();
        }
        if (chunk.content) {
          svc.state.streamingContent += chunk.content;
          svc.tokenBuffer += chunk.content;
        }
        if (chunk.reasoningContent) {
          svc.reasoningBuffer += chunk.reasoningContent;
        }
        if (!svc.flushTimer) {
          svc.flushTimer = setTimeout(
            () => svc.flushTokenBuffer(),
            FLUSH_INTERVAL_MS,
          );
        }
      },
      onComplete: () => {
        // If aborted, stopGeneration() already handled cleanup â€” don't clobber new generation state.
        if (svc.abortRequested) return;
        svc.forceFlushTokens();
        const generationTime = svc.state.startTime
          ? Date.now() - svc.state.startTime
          : undefined;
        chatStore.finalizeStreamingMessage(
          conversationId,
          generationTime,
          buildGenerationMetaImpl(svc),
        );
        svc.checkSharePrompt();
        svc.resetState();
      },
    });
  } catch (error) {
    if (svc.abortRequested) return;
    logger.error('[GenerationService] Generation error:', error);
    if (req.preservePartialOnError !== false) keepShownPartialOnError(svc, conversationId);
    throw error;
  }
}



export function fallbackRoutes(svc: any,messages: Message[]): FallbackRoute[] {
  const remote = useRemoteServerStore.getState();
  const local = useAppStore.getState();
  const startedRemote = svc.isUsingRemoteProvider();
  const selectedId = startedRemote ? remote.activeRemoteTextModelId : local.activeModelId;
  const selectedName = startedRemote
    ? remote.getActiveRemoteTextModel()?.name || selectedId || 'Remote model'
    : local.downloadedModels.find(model => model.id === selectedId)?.name || 'Local model';
  const needsVision = messages.some(message =>
    message.attachments?.some(attachment => attachment.type === 'image'),
  );
  const remoteRoutes = startedRemote
    ? remote.servers.flatMap(server =>
        (remote.discoveredModels[server.id] || [])
          .filter(model =>
            (server.id !== remote.activeServerId || model.id !== selectedId) &&
            (!needsVision || model.capabilities.supportsVision),
          )
          .map(model => ({ kind: 'remote' as const, serverId: server.id, id: model.id, name: model.name })),
      )
    : [];
  const localRoutes = local.downloadedModels
    .filter(model =>
      model.id !== selectedId &&
      (!needsVision || (model.engine === 'litert' ? model.liteRTVision : model.isVisionModel)),
    )
    .sort((a, b) => a.fileSize - b.fileSize)
    .map(model => ({ kind: 'local' as const, id: model.id, name: model.name }));
  return [
    startedRemote
      ? { kind: 'remote', serverId: remote.activeServerId || '', id: selectedId || '', name: selectedName }
      : { kind: 'local', id: selectedId || '', name: selectedName },
    ...remoteRoutes,
    ...localRoutes,
  ];
}

// eslint-disable-next-line max-params
export async function withModelFallback<T>(svc: any,
  conversationId: string,
  messages: Message[],
  run: (route: FallbackRoute, prepared: boolean) => Promise<T>,
  canRetry: () => boolean = () => true,
): Promise<T | void> {
  const routes = fallbackRoutes(svc, messages);
  let failedName = routes[0].name;
  let lastError: unknown;
  let prepared = false;
  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index];
    if (index > 0) {
      try {
        if (route.kind === 'remote') {
          await remoteServerManager.setActiveRemoteTextModel(route.serverId, route.id);
        } else {
          await activeModelService.loadTextModel(route.id);
          if (svc.abortRequested) return;
          await prepareActiveConversation(conversationId);
          if (svc.abortRequested) return;
          remoteServerManager.clearActiveRemoteTextModel();
        }
      } catch (error) {
        lastError = error;
        continue;
      }
      if (svc.abortRequested) return;
      if (svc.state.isGenerating) {
        svc.forceFlushTokens();
        useChatStore.getState().resetStreamingSegment();
        svc.updateState({ streamingContent: '', isThinking: true, startTime: Date.now() });
      }
      svc.tokenBuffer = '';
      svc.reasoningBuffer = '';
      svc.totalReasoningLength = 0;
      svc.remoteTimeToFirstToken = undefined;
      useChatStore.getState().addMessage(conversationId, {
        role: 'tool', toolName: 'model_fallback',
        content: `${failedName} could not answer. Trying ${route.name}.`,
      });
      prepared = svc.state.isGenerating;
    }
    try {
      return await run(route, prepared);
    } catch (error) {
      if (svc.abortRequested) return;
      if (contextCompactionService.isContextFullError(error)) {
        keepShownPartialOnError(svc, conversationId);
        throw error;
      }
      logger.warn(
        `[GenerationService] ${route.name} failed before model fallback: ${error instanceof Error ? error.message : String(error)}`,
      );
      lastError = error;
      failedName = route.name;
      if (!canRetry()) break;
    }
  }
  if (svc.state.isGenerating) keepShownPartialOnError(svc, conversationId);
  throw lastError;
}
