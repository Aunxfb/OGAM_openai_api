// LiteRT engine response path (extracted from generationServiceHelpers to keep it
// within the file-size budget). Each receives the GenerationService instance as `svc: any`.
import { liteRTService } from './litert';
import { useAppStore, useChatStore } from '../stores';
import type { GenerationMeta } from '../types';
import { modelInputImageUris, modelInputAudioUris } from './modelMedia';
import {
  buildGenerationMetaImpl,
  FLUSH_INTERVAL_MS,
  keepShownPartialOnError,
  type GenerationRequest,
} from './generationServiceHelpers';
import { buildLiteRTHistory } from './generationToolLoop';
import logger from '../utils/logger';

export function buildLiteRTMeta(
  svc: any,
  modelName: string | undefined,
): GenerationMeta {
  const backend = liteRTService.getActiveBackend() ?? 'cpu';
  const stats =
    svc.liteRTBenchmarkStats ?? liteRTService.getLastBenchmarkStats();
  if (stats) {
    return {
      gpu: backend !== 'cpu',
      gpuBackend: backend.toUpperCase(),
      modelName,
      decodeTokensPerSecond: stats.decodeTokensPerSecond,
      prefillTokensPerSecond: stats.prefillTokensPerSecond,
      timeToFirstToken: stats.ttft,
      tokenCount: stats.prefillTokenCount,
      modelLoadTimeSeconds:
        stats.initTimeSeconds > 0 ? stats.initTimeSeconds : undefined,
    };
  }
  const contentLength = svc.state.streamingContent?.length ?? 0;
  const estimatedTokenCount = Math.ceil(contentLength / 4);
  const genTime = svc.state.startTime
    ? (Date.now() - svc.state.startTime) / 1000
    : 0;
  return {
    gpu: backend !== 'cpu',
    gpuBackend: backend.toUpperCase(),
    modelName,
    tokenCount: estimatedTokenCount,
    tokensPerSecond:
      genTime > 0 && estimatedTokenCount > 0
        ? estimatedTokenCount / genTime
        : undefined,
  };
}

export function assertLiteRTImageSupport(
  imageUris: string[] | undefined,
  svc: any,
  chatStore: ReturnType<typeof useChatStore.getState>,
): void {
  if (!imageUris || imageUris.length === 0) return;
  const { downloadedModels, activeModelId } = useAppStore.getState();
  const activeModel = downloadedModels.find((m: any) => m.id === activeModelId);
  const liteRTActiveModel =
    activeModel?.engine === 'litert' ? activeModel : null;
  if (!liteRTActiveModel?.liteRTVision) {
    chatStore.clearStreamingMessage();
    svc.resetState();
    throw new Error(
      'This model does not support images. Import it with vision enabled, or remove the image.',
    );
  }
}

// assertLiteRTAudioSupport removed: audio is transcript-only (modelInputAudioUris always []), so it
// only ever wrongly hard-rejected a non-audio LiteRT model carrying a voice note. Re-gate at modelMedia.

export async function runLiteRTResponseImpl(
  svc: any,
  req: GenerationRequest,
): Promise<void> {
  const { conversationId, messages, onFirstToken } = req;
  const chatStore = useChatStore.getState();
  let firstTokenReceived = false;
  let jsTtftSeconds: number | undefined;

  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUser) {
    chatStore.clearStreamingMessage();
    svc.resetState();
    return;
  }
  const systemMsg = messages.find(m => m.role === 'system');
  const systemPrompt =
    typeof systemMsg?.content === 'string' ? systemMsg.content : '';
  const allAttachments = lastUser.attachments ?? [];
  // Single source of truth (modelMedia): images may be model input; a voice note is transcript-only
  // (audioUris ALWAYS empty — transcript is already in lastUser.content), matching the llama/OAI path.
  const imageUris = modelInputImageUris(allAttachments);
  const audioUris = modelInputAudioUris(allAttachments);

  assertLiteRTImageSupport(imageUris, svc, chatStore);

  const history = buildLiteRTHistory(messages);

  try {
    const { settings } = useAppStore.getState();
    await liteRTService.prepareConversation(conversationId, systemPrompt, {
      samplerConfig: {
        temperature: settings.liteRTTemperature,
        topP: settings.liteRTTopP,
      },
      history,
    });

    await liteRTService.sendMessage(
      typeof lastUser.content === 'string' ? lastUser.content : '',
      {
        onToken: (token: string) => {
          if (svc.abortRequested) return;
          if (jsTtftSeconds === undefined && svc.state.startTime) {
            jsTtftSeconds = (Date.now() - svc.state.startTime) / 1000;
          }
          if (!firstTokenReceived) {
            firstTokenReceived = true;
            svc.updateState({ isThinking: false });
            onFirstToken?.();
          }
          svc.state.streamingContent += token;
          svc.tokenBuffer += token;
          if (!svc.flushTimer) {
            svc.flushTimer = setTimeout(
              () => svc.flushTokenBuffer(),
              FLUSH_INTERVAL_MS,
            );
          }
        },
        onReasoning: (token: string) => {
          if (svc.abortRequested) return;
          // Capture TTFT on first thinking token so it reflects time-to-first-visible-output
          if (jsTtftSeconds === undefined && svc.state.startTime) {
            jsTtftSeconds = (Date.now() - svc.state.startTime) / 1000;
          }
          svc.reasoningBuffer += token;
          if (!svc.flushTimer) {
            svc.flushTimer = setTimeout(
              () => svc.flushTokenBuffer(),
              FLUSH_INTERVAL_MS,
            );
          }
        },
        onComplete: (_content: string, _reasoning: string, stats) => {
          if (svc.abortRequested) return;
          svc.forceFlushTokens();
          svc.liteRTBenchmarkStats = stats
            ? { ...stats, ttft: jsTtftSeconds ?? stats.ttft }
            : stats;
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
        onError: (err: Error) => {
          if (svc.abortRequested) return;
          logger.error('[LiteRT] sendMessage error:', err.message);
          if (req.preservePartialOnError === false) throw err;
          keepShownPartialOnError(svc, conversationId); // keep the partial the user already saw
        },
      },
      { imageUris, audioUris },
    );
  } catch (error: any) {
    if (svc.abortRequested) return;
    if (req.preservePartialOnError !== false) keepShownPartialOnError(svc, conversationId);
    throw error;
  }
}
