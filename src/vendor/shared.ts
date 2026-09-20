/**
 * Vendored shared UI rules (no `../shared` dependency).
 *
 * This branch rejects the out-of-root `@offgrid/*` `file:../shared` monorepo
 * packages, so the small pure helpers the chat UI used to import from
 * `@offgrid/sync` live here instead. One definition per concept (SSOT):
 * every importer in `src/` reads these, never a copy.
 *
 * Behaviour notes (each pinned by a test below):
 * - `chatListPreviewLine`: single-line `You: …` conversation summary. The
 *   shared rule also truncated and collapsed whitespace so a pasted code
 *   block could not blow a list row apart; this copy does the same.
 * - `preprocessChatMarkdown`: escapes `digit*digit` asterisks (multiplication)
 *   so markdown-it does not read them as emphasis. Identical to the local
 *   implementation this repo carried before the shared import.
 * - `safeChatExternalUrl`: allow-list for opening links from chat bubbles.
 *   Only `http(s)` URLs open; anything else (deep links, `javascript:`,
 *   unparsable input) is refused so a crafted message cannot trigger an
 *   unexpected handler.
 */

/** Provenance carried on a message record: which device wrote it. */
export interface MessageProvenance {
  originDeviceId?: string | null;
}

const PREVIEW_MAX_CHARS = 120;

/**
 * One-line summary of a conversation for any list that shows one.
 * Returns '' when there is nothing to summarise.
 */
export function chatListPreviewLine(
  role: string | undefined,
  content: string | undefined,
): string {
  const line = (content ?? '').replace(/\s+/g, ' ').trim();
  if (!line) return '';
  const cut =
    line.length > PREVIEW_MAX_CHARS
      ? `${line.slice(0, PREVIEW_MAX_CHARS).trimEnd()}…`
      : line;
  return role === 'user' ? `You: ${cut}` : cut;
}

/** Escape `*` used as multiplication (`5*5`) so it is not read as emphasis. */
export function preprocessChatMarkdown(text: string): string {
  return text.replaceAll(/(\d)\*(?=\d)/g, String.raw`$1\*`);
}

/**
 * Gate a URL tapped inside a chat bubble. Returns the URL when it is safe
 * to open, `null` when it must be ignored.
 */
export function safeChatExternalUrl(url: string): string | null {
  const trimmed = (url ?? '').trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return null;
}
