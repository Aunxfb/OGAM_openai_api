import { Message } from '../../types';
import { visibleMessages } from '../../utils/visibleMessages';
export type ChatMessageItem = {
  id: string;
  role: 'assistant';
  content: string;
  reasoningContent?: string;
  timestamp: number;
  isThinking?: boolean;
  isStreaming?: boolean;
};

export type StreamingState = {
  isThinking: boolean;
  streamingMessage: string;
  streamingReasoningContent: string;
  hasStreamingText?: boolean;
  isStreamingForThisConversation: boolean;
  isModelLoading?: boolean;
  loadingModelName?: string;
  isGeneratingForThisConversation?: boolean;
  /** This device's mesh id, so a peer's runtime notices can be told apart from its own. */
  localDeviceId?: string | null;
};

let _lastDisplayBranch = '';
export function getDisplayMessages(
  allMessages: Message[],
  streaming: StreamingState,
): (Message | ChatMessageItem)[] {
  // The same rule the list rows use, so the thread and its preview never disagree.
  return localDisplayMessages(
    [...visibleMessages(allMessages, streaming.localDeviceId)],
    streaming,
  );
}

function localDisplayMessages(
  allMessages: Message[],
  streaming: StreamingState,
): (Message | ChatMessageItem)[] {
  const { isThinking, streamingMessage, streamingReasoningContent, isStreamingForThisConversation } = streaming;
  // Model still loading for the in-progress reply: show it in the bubble so the
  // wait is explained ("Loading <model>…") instead of bare dots.
  if (streaming.isModelLoading && streaming.isGeneratingForThisConversation && !streamingMessage && !streaming.hasStreamingText) {
    return [
      ...allMessages,
      { id: 'thinking', role: 'assistant' as const, content: streaming.loadingModelName ? `Loading ${streaming.loadingModelName}...` : 'Loading model...', timestamp: Date.now(), isThinking: true },
    ];
  }
  if (isThinking && isStreamingForThisConversation) {
    if (_lastDisplayBranch !== 'thinking') {
      _lastDisplayBranch = 'thinking';
    }
    return [
      ...allMessages,
      { id: 'thinking', role: 'assistant' as const, content: '', timestamp: Date.now(), isThinking: true },
    ];
  }
  if ((streamingMessage || streamingReasoningContent || streaming.hasStreamingText) && isStreamingForThisConversation) {
    if (_lastDisplayBranch !== 'streaming') {
      _lastDisplayBranch = 'streaming';
    }
    return [
      ...allMessages,
      { id: 'streaming', role: 'assistant' as const, content: streamingMessage, reasoningContent: streamingReasoningContent || undefined, timestamp: Date.now(), isStreaming: true },
    ];
  }
  if (_lastDisplayBranch !== 'done') {
    _lastDisplayBranch = 'done';
  }
  return allMessages;
}

type PlaceholderTextOptions = {
  hasModel: boolean;
  isModelLoading: boolean;
  supportsVision: boolean;
  imageOnly?: boolean;
};

export function getPlaceholderText({
  hasModel,
  isModelLoading,
  supportsVision,
  imageOnly,
}: PlaceholderTextOptions): string {
  if (!hasModel) return isModelLoading ? 'Loading model...' : 'Load a model to use chat';
  if (imageOnly) return 'Describe an image...';
  return supportsVision ? 'Type a message or add an image...' : 'Type a message...';
}
