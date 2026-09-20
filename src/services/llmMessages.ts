import { RNLlamaOAICompatibleMessage, RNLlamaMessagePart } from 'llama.rn';
import RNFS from 'react-native-fs';
import { Message, MediaAttachment } from '../types';
import logger from '../utils/logger';

/**
 * PRODUCT RULE: every voice note is transcribed (whisper) and ONLY its transcript is sent to the
 * model — the audio attachment is display/playback ONLY, never model input. So the llama message
 * builders NEVER attach audio as media. Sending the audio broke turns two ways:
 *  - the transcript is already in message.content, so the audio is redundant; and
 *  - the audio path is an absolute iOS container path that goes stale on reinstall/rebuild (new
 *    container UUID) → "File does not exist or cannot be opened", hard-failing every voice-mode turn
 *    in a persisted conversation (B9); a non-audio mmproj also throws "Failed to load media" (B5).
 * Returning [] unconditionally enforces the transcript-only contract for every model + state
 * (including a not-yet-transcribed note — which must not reach the model as raw audio either). */
function modelAudioAttachments(_attachments: MediaAttachment[] | undefined): MediaAttachment[] {
  return [];
}

export function formatLlamaMessages(messages: Message[], supportsVision: boolean, supportsAudio = false): string {
  let prompt = '';
  for (const message of messages.filter(m => !m.isSystemInfo)) {
    if (message.role === 'system') {
      prompt += `<|im_start|>system\n${message.content}<|im_end|>\n`;
    } else if (message.role === 'user') {
      let content = message.content;
      if (message.attachments && message.attachments.length > 0) {
        const imageMarkers = supportsVision
          ? message.attachments.filter(a => a.type === 'image').map(() => '<__media__>').join('')
          : '';
        const audioMarkers = supportsAudio
          ? modelAudioAttachments(message.attachments).map(() => '<__media__>').join('')
          : '';
        content = imageMarkers + audioMarkers + content;
      }
      prompt += `<|im_start|>user\n${content}<|im_end|>\n`;
    } else if (message.role === 'assistant') {
      prompt += `<|im_start|>assistant\n${message.content}<|im_end|>\n`;
    }
  }
  prompt += '<|im_start|>assistant\n';
  return prompt;
}

export function extractImageUris(messages: Message[]): string[] {
  const uris: string[] = [];
  for (const message of messages) {
    if (message.attachments) {
      for (const attachment of message.attachments) {
        if (attachment.type === 'image') {
          uris.push(attachment.uri);
        }
      }
    }
  }
  return uris;
}

/**
 * Format a tool call as plain text for the assistant message.
 * Avoids structured tool_calls which cause Jinja template errors
 * (C++ wants arguments as string, Jinja wants dict — can't satisfy both).
 */
function formatToolCallAsText(tc: { name: string; arguments: string }): string {
  const escapedName = JSON.stringify(tc.name);
  return `<tool_call>{"name":${escapedName},"arguments":${tc.arguments}}</tool_call>`;
}

function toFileUrl(uri: string, requireFilePrefix = false): string {
  if (requireFilePrefix) return uri.startsWith('file://') ? uri : `file://${uri}`;
  return uri.startsWith('file://') || uri.startsWith('http') ? uri : `file://${uri}`;
}

function buildMediaParts(message: Message, supportsAudio: boolean): RNLlamaMessagePart[] {
  const parts: RNLlamaMessagePart[] = [];
  for (const a of message.attachments?.filter(att => att.type === 'image') ?? []) {
    parts.push({ type: 'image_url', image_url: { url: toFileUrl(a.uri) } });
  }
  if (supportsAudio) {
    for (const a of modelAudioAttachments(message.attachments)) {
      parts.push({ type: 'input_audio', input_audio: { format: a.audioFormat ?? 'wav', url: toFileUrl(a.uri, true) } });
    }
  }
  if (message.content) parts.push({ type: 'text', text: message.content });
  return parts;
}

export function buildOAIMessages(messages: Message[], supportsAudio = false): RNLlamaOAICompatibleMessage[] {
  return messages.filter(m => !m.isSystemInfo).map((message) => {
    if (message.role === 'tool') {
      const label = message.toolName || 'tool';
      return { role: 'user' as const, content: `[Tool Result: ${label}]\n${message.content}\n[End Tool Result]` };
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const toolCallText = message.toolCalls.map(formatToolCallAsText).join('\n');
      return { role: 'assistant' as const, content: message.content ? `${message.content}\n${toolCallText}` : toolCallText };
    }
    const hasImage = message.role === 'user' && message.attachments?.some(a => a.type === 'image');
    const hasAudio = supportsAudio && message.role === 'user' && modelAudioAttachments(message.attachments).length > 0;
    if (!hasImage && !hasAudio) return { role: message.role, content: message.content };
    return { role: message.role, content: buildMediaParts(message, supportsAudio) };
  });
}

/** No-op pass-through — lets llama.rn's native ctx_shift handle overflow for KV cache reuse. */
export async function manageContextWindow(messages: Message[], _extraReserve = 0): Promise<Message[]> {
  return messages;
}

/**
 * Drop image attachments whose files no longer exist before they reach the native
 * layer. A generated image's uri is a temp/cache path that gets cleaned up, so once
 * it's in the conversation history EVERY later turn (even a voice note) flips to
 * VISION mode and the native completion throws, killing the whole turn (silent
 * empty bubble). Validating file inputs at this boundary is the generation layer's
 * own responsibility — a missing image is simply not sent, so the turn runs
 * (TEXT-ONLY if none remain) instead of crashing.
 */
export async function dropMissingImageAttachments(messages: Message[]): Promise<Message[]> {
  const out: Message[] = [];
  for (const m of messages) {
    const attachments = m.attachments;
    if (!attachments?.some(a => a.type === 'image')) { out.push(m); continue; }
    const kept: typeof attachments = [];
    for (const a of attachments) {
      if (a.type !== 'image') { kept.push(a); continue; }
      const path = (a.uri || '').replace(/^file:\/\//, '');
      const exists = path.length > 0 && await RNFS.exists(path).catch(() => false);
      if (exists) kept.push(a);
      else logger.warn(`[LLM] dropping missing image attachment (file gone): ${a.uri}`);
    }
    out.push(kept.length === attachments.length ? m : { ...m, attachments: kept });
  }
  return out;
}
