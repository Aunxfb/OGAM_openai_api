/**
 * LocalServer OpenAI-protocol helpers — pure functions with no I/O.
 *
 * The SINGLE place that knows the llama-server-compatible v1 wire shapes:
 * route list, Bearer gating (health is public), FIFO admission (503 +
 * Retry-After when full), sampling allow-list (common subset parsed,
 * exotics accepted-and-ignored), and SSE framing. Both the owning service
 * and the contract tests speak these helpers; nothing redefines them.
 */

export const LOCAL_SERVER_V1_ROUTES = [
  'GET /health',
  'GET /v1/models',
  'POST /v1/chat/completions',
  'POST /v1/completions',
  'POST /v1/embeddings',
  'POST /tokenize',
  'POST /detokenize',
] as const;

/** Paths that never require the Bearer key (mirrors llama-server). */
const PUBLIC_PATHS = new Set(['/health']);

/**
 * Bearer gate. Health is public; everything else requires the configured key
 * when one is set. No key configured = open (the UI shows a warning banner).
 */
export function isAuthorizedRequest(path: string, authHeader: string | null, apiKey: string): boolean {
  if (PUBLIC_PATHS.has(path)) return true;
  if (!apiKey) return true;
  const token = (authHeader ?? '').replace(/^Bearer\s+/i, '').trim();
  return token.length > 0 && token === apiKey;
}

/** FIFO admission: `null` = admitted, otherwise the 503 Retry-After seconds. */
export function admitOrReject(activeCount: number, queueDepth: number): { admitted: boolean; retryAfterSec: number } {
  if (activeCount < queueDepth) return { admitted: true, retryAfterSec: 0 };
  return { admitted: false, retryAfterSec: 5 };
}

/** Common sampling subset honored per request (llama-server OAI parity). */
const COMMON_SAMPLING_KEYS = new Set([
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'repeat_penalty',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'max_tokens',
  'stop',
]);

export interface SplitSampling {
  /** Parsed common subset (present keys only). */
  common: Record<string, unknown>;
  /** Exotic keys that were accepted-and-ignored (v2). */
  ignored: string[];
}

/**
 * Split request sampling params into the honored common subset vs the
 * accepted-and-ignored exotics (`dry_*`, `mirostat_*`, `xtc_*`, `grammar`,
 * `json_schema`, ...). Never throws on unknown keys — v1 ignores them.
 */
export function splitSamplingParams(params: Record<string, unknown>): SplitSampling {
  const common: Record<string, unknown> = {};
  const ignored: string[] = [];
  for (const key of Object.keys(params)) {
    if (key === 'stream') continue;
    if (COMMON_SAMPLING_KEYS.has(key)) common[key] = params[key];
    else ignored.push(key);
  }
  return { common, ignored };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Normalize a chat-completions `messages` array to plain text turns. Rejects
 * non-text content parts (v1 serves text only) with a typed error the route
 * layer turns into a 400 — never silently drops user content.
 */
export function normalizeChatMessages(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages must be a non-empty array');
  }
  return messages.map((m, i) => {
    const role = (m as { role?: unknown })?.role;
    const content = (m as { content?: unknown })?.content;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw new Error(`messages[${i}].role must be system, user, or assistant`);
    }
    if (typeof content !== 'string') {
      throw new Error(`messages[${i}].content must be a string in v1 (no vision parts)`);
    }
    return { role, content };
  });
}

/** SSE framing exactly per llama-server OAI routes: `data: {chunk}` … `data: [DONE]`. */
export function formatSSEChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const SSE_DONE = 'data: [DONE]\n\n';

/** Chat-completions chunk envelope for one streamed delta. */
export function chatChunkEnvelope(args: {
  model: string;
  delta: string;
  id: string;
  created: number;
}): object {
  return {
    id: args.id,
    object: 'chat.completion.chunk',
    created: args.created,
    model: args.model,
    choices: [{ index: 0, delta: { content: args.delta }, finish_reason: null }],
  };
}

/** `/v1/models` single fixed entry for the currently loaded model. */
export function modelsListPayload(modelId: string): object {
  return {
    object: 'list',
    data: [{ id: modelId, object: 'model', created: 0, owned_by: 'offgrid' }],
  };
}

/** Parse a JSON request body into a plain object. Throws a typed error the
 *  route layer turns into a 400 — never throws a SyntaxError across layers. */
export function parseJsonBody(body: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('request body must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** True when the caller asked for SSE (`"stream": true`); anything else
 *  (absent, false, non-boolean) answers with a single JSON object. */
export function isStreamRequested(params: Record<string, unknown>): boolean {
  return params.stream === true;
}

/** Non-streaming `POST /v1/chat/completions` response envelope. */
export function chatCompletionJson(args: {
  model: string;
  text: string;
  id: string;
  created: number;
}): object {
  return {
    id: args.id,
    object: 'chat.completion',
    created: args.created,
    model: args.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: args.text },
        finish_reason: 'stop',
      },
    ],
  };
}

/** Non-streaming `POST /v1/completions` (legacy text) response envelope. */
export function textCompletionJson(args: {
  model: string;
  text: string;
  id: string;
  created: number;
}): object {
  return {
    id: args.id,
    object: 'text_completion',
    created: args.created,
    model: args.model,
    choices: [{ index: 0, text: args.text, finish_reason: 'stop' }],
  };
}

/** `POST /tokenize` response: `{"tokens": [...]}` per llama-server. */
export function tokenizeJson(tokens: number[]): object {
  return { tokens };
}

/** `POST /detokenize` response: `{"content": "..."}` per llama-server. */
export function detokenizeJson(text: string): object {
  return { content: text };
}

/** 401 body for Bearer-gated routes. */
export function unauthorizedBody(): object {
  return { error: { message: 'unauthorized', type: 'auth_error' } };
}

/** 404 body for unknown routes. */
export function notFoundBody(): object {
  return { error: { message: 'not found', type: 'not_found' } };
}

/** 501 body for v1-deferred routes (real embeddings are v2 per T0). */
export function embeddingsUnavailableBody(): object {
  return {
    error: { message: 'embeddings are not available in v1', type: 'not_implemented' },
  };
}

/** 503 body served while the model is (un)loading — never silently drops. */
export function modelLoadingBody(): object {
  return { error: { message: 'model loading', type: 'server_error', code: 'model_loading' } };
}
