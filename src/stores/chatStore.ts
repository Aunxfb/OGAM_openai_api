import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Message, Conversation, GenerationMeta } from '../types';
import {
  stripStreamingControlTokens,
} from '../utils/messageContent';
import { generateId } from '../utils/generateId';
import { createHydrationGatedStorage } from '../utils/hydrationGatedStorage';
import {
  finalizeStreamedReply,
  type ReplyEnd,
} from './chatStoreReplyFinalization';
import { callHook, HOOKS } from '../bootstrap/hookRegistry';

function nextUpdatedAt(previousUpdatedAt?: string): string {
  const now = Date.now();
  if (!previousUpdatedAt) return new Date(now).toISOString();
  const previousTime = Date.parse(previousUpdatedAt);
  const nextTime = Number.isNaN(previousTime) ? now : Math.max(now, previousTime + 1);
  return new Date(nextTime).toISOString();
}

/** Update a single message inside a conversation's messages array. */
function updateMessageInConv(
  conv: Conversation,
  messageId: string,
  updater: (msg: Message) => Message,
): Conversation {
  return {
    ...conv,
    messages: conv.messages.map((msg) => (msg.id === messageId ? updater(msg) : msg)),
    updatedAt: nextUpdatedAt(conv.updatedAt),
  };
}

/**
 * The portion of the in-progress stream that is safe to SPEAK in voice mode —
 * never the reasoning/thinking. Models that stream reasoning on a separate
 * channel leave streamingMessage answer-only. Models that inline reasoning (e.g.
 * Qwen3, whose chat template injects the opening <think> so only a closing
 * </think> is emitted) are sliced at </think>; until that tag arrives we withhold
 * (return '') while thinking is enabled, so the thought process is never spoken
 * sentence-by-sentence. onStreamingEnd still speaks the final answer if nothing
 * streamed.
 */
function speakableStreamingAnswer(streamingMessage: string, streamingReasoning: string): string {
  if (streamingReasoning.length > 0) return streamingMessage; // reasoning came separately
  const closeIdx = streamingMessage.toLowerCase().lastIndexOf('</think>');
  if (closeIdx !== -1) return streamingMessage.slice(closeIdx + '</think>'.length);
  // No close tag yet: inline reasoning may still be in progress. Withhold while
  // thinking is enabled; otherwise the content is the answer and is safe to speak.
  const { useAppStore } = require('./appStore');
  return useAppStore.getState().settings?.thinkingEnabled ? '' : streamingMessage;
}

/** Derive conversation title from the first user message. */
function deriveTitle(currentTitle: string, role: string, content: string): string {
  if (currentTitle !== 'New Conversation' || role !== 'user') return currentTitle;
  const truncated = content.slice(0, 50);
  return content.length > 50 ? `${truncated}...` : truncated;
}

/** Map over conversations, applying `updater` only to the one matching `conversationId`. */
function mapConversation(
  conversations: Conversation[],
  conversationId: string,
  updater: (conv: Conversation) => Conversation,
): Conversation[] {
  return conversations.map((conv) => (conv.id === conversationId ? updater(conv) : conv));
}

interface ChatState {
  conversations: Conversation[];
  activeConversationId: string | null;
  streamingMessage: string;
  streamingReasoningContent: string;
  streamingForConversationId: string | null;
  isStreaming: boolean;
  isThinking: boolean;
  createConversation: (modelId: string, title?: string, projectId?: string) => string;
  deleteConversation: (conversationId: string) => void;
  setActiveConversation: (conversationId: string | null) => void;
  getActiveConversation: () => Conversation | null;
  setConversationProject: (conversationId: string, projectId: string | null) => void;
  /** Unfile every conversation filed under a project (used when the project is deleted,
   *  so no chat is left pointing at a project that no longer exists). */
  unfileConversationsForProject: (projectId: string) => void;
  addMessage: (conversationId: string, message: Omit<Message, 'id' | 'timestamp'>) => Message;
  updateMessageContent: (conversationId: string, messageId: string, content: string) => void;
  updateMessageThinking: (conversationId: string, messageId: string, isThinking: boolean) => void;
  /** Stamp the modality a USER message's turn was dispatched as (see #20: resend replays the
   *  decision instead of re-deriving it from surviving replies). */
  updateMessageTurnKind: (
    conversationId: string,
    messageId: string,
    turnKind: NonNullable<Message['turnKind']>,
  ) => void;
  updateMessageAudio: (conversationId: string, messageId: string, audio: { audioPath?: string; waveformData?: number[]; audioDurationSeconds?: number; isGeneratingAudio?: boolean; isAudioModeMessage?: boolean }) => void;
  deleteMessage: (conversationId: string, messageId: string) => void;
  deleteMessagesAfter: (conversationId: string, messageId: string) => void;
  startStreaming: (conversationId: string) => void;
  setStreamingMessage: (content: string) => void;
  appendToStreamingMessage: (token: string) => void;
  appendToStreamingReasoningContent: (token: string) => void;
  /** Start the next reasoning/answer segment without ending the reply or changing its identity. */
  resetStreamingSegment: () => void;
  setIsStreaming: (streaming: boolean) => void;
  setIsThinking: (thinking: boolean) => void;
  /**
   * The text model is loading, and which one.
   *
   * Here rather than in ChatScreen's `useState`, which is where it used to live. A fact known only
   * to a component is a fact sync cannot see: the phone showed "Loading Qwen3.5 2B" for tens of
   * seconds while every paired device sat on "Preparing reply...", because the live-stream service
   * subscribes to THIS store and there was nothing here to read. The image path never had the bug -
   * its loading state was always a published phase.
   */
  isModelLoading: boolean;
  loadingModelName: string | null;
  setIsModelLoading: (loading: boolean) => void;
  setLoadingModelName: (name: string | null) => void;
  lastReplyEnd: ReplyEnd | null;
  noteReplyEndHandled: () => void;
  finalizeStreamingMessage: (conversationId: string, generationTimeMs?: number, generationMeta?: GenerationMeta) => void;
  clearStreamingMessage: () => void;
  getStreamingState: () => { conversationId: string | null; content: string; reasoningContent: string; isStreaming: boolean; isThinking: boolean };
  updateCompactionState: (conversationId: string, summary?: string, cutoffMessageId?: string) => void;
  clearAllConversations: () => void;
  getConversationMessages: (conversationId: string) => Message[];
}

/** The streaming fields, named so a caller can say WHICH state it means rather than list it. */
type StreamingFields = Pick<
  ChatState,
  | 'streamingMessage'
  | 'streamingReasoningContent'
  | 'streamingForConversationId'
  | 'isStreaming'
  | 'isThinking'
>;

/**
 * No reply is forming. ONE definition, because that is one fact.
 *
 * It used to be written out in four places - the initial state, the start of a stream, the end of
 * one, and a cancel - so every field added to the streaming state had to be remembered in all four,
 * and whichever copy was missed would leak that field into the next reply. The type is a `Pick`, so
 * adding a streaming field is a compile error here until it is given a cleared value.
 */
const MODEL_NOT_LOADING = {
  isModelLoading: false,
  loadingModelName: null,
};

const NO_REPLY_ENDED = { lastReplyEnd: null };

const NO_REPLY_FORMING: StreamingFields = {
  streamingMessage: '',
  streamingReasoningContent: '',
  streamingForConversationId: null,
  isStreaming: false,
  isThinking: false,
};

/** Durable chat state (subset written to storage). */
interface PersistedChatState {
  conversations: Conversation[];
  activeConversationId: string | null;
}

const chatStorage = createHydrationGatedStorage<PersistedChatState>(
  undefined,
  (previous, next) =>
    previous.conversations === next.conversations &&
    previous.activeConversationId === next.activeConversationId,
);
export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      conversations: [],
      activeConversationId: null,
      ...NO_REPLY_FORMING,
      ...MODEL_NOT_LOADING,
      ...NO_REPLY_ENDED,

      createConversation: (modelId, title, projectId) => {
        const id = generateId();
        const conversation: Conversation = {
          id,
          title: title || 'New Conversation',
          modelId,
          messages: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          projectId: projectId,
        };

        set((state) => ({
          conversations: [conversation, ...state.conversations],
          activeConversationId: id,
        }));

        return id;
      },

      deleteConversation: (conversationId) => {
        set((state) => ({
          conversations: state.conversations.filter((c) => c.id !== conversationId),
          activeConversationId: state.activeConversationId === conversationId ? null : state.activeConversationId,
        }));
      },

      setActiveConversation: (conversationId) => {
        set({ activeConversationId: conversationId });
      },

      getActiveConversation: () => {
        const state = get();
        return state.conversations.find((c) => c.id === state.activeConversationId) || null;
      },

      setConversationProject: (conversationId, projectId) => {
        set((state) => ({
          conversations: state.conversations.map((conv) =>
            conv.id !== conversationId
              ? conv
              : { ...conv, projectId: projectId || undefined, updatedAt: nextUpdatedAt(conv.updatedAt) }
          ),
        }));
      },

      unfileConversationsForProject: (projectId) => {
        set((state) => ({
          conversations: state.conversations.map((conv) =>
            conv.projectId !== projectId
              ? conv
              : { ...conv, projectId: undefined, updatedAt: nextUpdatedAt(conv.updatedAt) }
          ),
        }));
      },

      addMessage: (conversationId, messageData) => {
        const message: Message = {
          id: generateId(),
          ...messageData,
          timestamp: Date.now(),
        };

        set((state) => ({
          conversations: state.conversations.map((conv) =>
            conv.id === conversationId
              ? {
                  ...conv,
                  messages: [...conv.messages, message],
                  updatedAt: nextUpdatedAt(conv.updatedAt),
                  title: deriveTitle(conv.title, messageData.role, messageData.content),
                }
              : conv
          ),
        }));

        return message;
      },

      updateMessageContent: (conversationId, messageId, content) => {
        set((state) => ({
          conversations: mapConversation(state.conversations, conversationId, (conv) =>
            updateMessageInConv(conv, messageId, (msg) => ({ ...msg, content }))
          ),
        }));
      },

      updateMessageThinking: (conversationId, messageId, isThinking) => {
        set((state) => ({
          conversations: mapConversation(state.conversations, conversationId, (conv) =>
            updateMessageInConv(conv, messageId, (msg) => ({ ...msg, isThinking }))
          ),
        }));
      },

      updateMessageTurnKind: (conversationId, messageId, turnKind) => {
        set((state) => ({
          conversations: mapConversation(state.conversations, conversationId, (conv) =>
            updateMessageInConv(conv, messageId, (msg) => ({ ...msg, turnKind }))
          ),
        }));
      },

      updateMessageAudio: (conversationId, messageId, audio) => {
        set((state) => ({ conversations: mapConversation(state.conversations, conversationId, (conv) => updateMessageInConv(conv, messageId, (msg) => ({ ...msg, ...audio }))) }));
      },

      deleteMessage: (conversationId, messageId) => {
        set((state) => ({
          conversations: mapConversation(state.conversations, conversationId, (conv) => ({
            ...conv,
            messages: conv.messages.filter((msg) => msg.id !== messageId),
            updatedAt: nextUpdatedAt(conv.updatedAt),
          })),
        }));
      },

      deleteMessagesAfter: (conversationId, messageId) => {
        set((state) => ({
          conversations: mapConversation(state.conversations, conversationId, (conv) => {
            const messageIndex = conv.messages.findIndex((msg) => msg.id === messageId);
            if (messageIndex === -1) return conv;
            return {
              ...conv,
              messages: conv.messages.slice(0, messageIndex + 1),
              updatedAt: nextUpdatedAt(conv.updatedAt),
            };
          }),
        }));
      },

      startStreaming: (conversationId) => {
        set({
          streamingForConversationId: conversationId,
          streamingMessage: '',
          streamingReasoningContent: '',
          isStreaming: false,
          isThinking: true,
        });
      },

      setStreamingMessage: (content) => {
        set({ streamingMessage: content });
      },

      appendToStreamingMessage: (token) => {
        set((state) => ({
          streamingMessage: stripStreamingControlTokens(state.streamingMessage + token),
          isStreaming: true,
          isThinking: false,
        }));
        // Feed only the ANSWER to pro audio for real-time sentence-by-sentence
        // TTS (never the reasoning) — no-op unless voice mode + engine ready;
        // free builds register nothing.
        callHook(HOOKS.audioOnStreamingToken, speakableStreamingAnswer(get().streamingMessage, get().streamingReasoningContent));
      },

      appendToStreamingReasoningContent: (token) => {
        set((state) => ({
          streamingReasoningContent: state.streamingReasoningContent + token,
          isStreaming: true,
          isThinking: false,
        }));
      },

      resetStreamingSegment: () => {
        set({ streamingMessage: '', streamingReasoningContent: '' });
      },

      setIsStreaming: (streaming) => {
        set({ isStreaming: streaming, isThinking: false });
      },

      setIsThinking: (thinking) => {
        set({ isThinking: thinking });
      },

      finalizeStreamingMessage: (conversationId, generationTimeMs, generationMeta) => {
        const { streamingMessage, streamingReasoningContent, streamingForConversationId, addMessage } = get();

        const { persisted, content, reasoningContent } = finalizeStreamedReply({
          streamingMessage,
          streamingReasoningContent,
          streamingForConversationId,
          conversationId,
        });
        // End the ephemeral reply before the durable mutation leaves this device. Both use the same
        // peer link. This order guarantees a receiver sees the final stream frame first and then the
        // record that replaces it, never the reverse order that could recreate a retired preview.
        set({ ...NO_REPLY_FORMING, lastReplyEnd: { conversationId, persisted } });
        if (persisted) {
          addMessage(conversationId, {
            role: 'assistant',
            content,
            reasoningContent,
            generationTimeMs,
            generationMeta,
          });
        }
        set({
          streamingMessage: '',
          streamingReasoningContent: '',
          streamingForConversationId: null,
          isStreaming: false,
          isThinking: false,
        });
      },

      clearStreamingMessage: () => {
        // Nothing was shown and nothing is stored, so any peer preview for this reply is orphaned.
        const conversationId = get().streamingForConversationId;
        set({
          ...NO_REPLY_FORMING,
          ...(conversationId
            ? { lastReplyEnd: { conversationId, persisted: false } }
            : {}),
        });
      },

      noteReplyEndHandled: () => set(NO_REPLY_ENDED),

      setIsModelLoading: (loading: boolean) => set({ isModelLoading: loading }),
      setLoadingModelName: (name: string | null) =>
        set({ loadingModelName: name }),

      getStreamingState: () => {
        const state = get();
        return {
          conversationId: state.streamingForConversationId,
          content: state.streamingMessage,
          reasoningContent: state.streamingReasoningContent,
          isStreaming: state.isStreaming,
          isThinking: state.isThinking,
          isModelLoading: state.isModelLoading,
          loadingModelName: state.loadingModelName,
        };
      },

      updateCompactionState: (conversationId, summary, cutoffMessageId) => {
        set((state) => ({
          conversations: state.conversations.map((conv) =>
            conv.id === conversationId
              ? {
                  ...conv,
                  compactionSummary: summary,
                  compactionCutoffMessageId: cutoffMessageId,
                  updatedAt: nextUpdatedAt(conv.updatedAt),
                }
              : conv
          ),
        }));
      },

      clearAllConversations: () => {
        set({ conversations: [], activeConversationId: null });
      },

      getConversationMessages: (conversationId) => {
        const conversation = get().conversations.find((c) => c.id === conversationId);
        return conversation?.messages || [];
      },
    }),
    {
      name: 'local-llm-chat-storage',
      storage: chatStorage.storage,
      onRehydrateStorage: () => () => chatStorage.markHydrated(),
      partialize: (state): PersistedChatState => ({
        conversations: state.conversations,
        activeConversationId: state.activeConversationId,
      }),
    }
  )
);
