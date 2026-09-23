/**
 * Settings persist migrations + the token-ceiling clamp.
 *
 * Extracted from appStore.ts (which sits at the repo's 500-line lint gate).
 * Pure functions over the rehydrated state — no store imports, so no cycles.
 */
import { MAX_TOKEN_LIMIT } from '../constants';

/** Settings keys hard-capped at MAX_TOKEN_LIMIT (128K slider ceiling). */
export const TOKEN_CAPPED_KEYS = ['maxTokens', 'contextLength', 'liteRTMaxTokens'] as const;

export function migrateEnabledTools(merged: any): void {
  if (merged.settings?.enabledTools && !merged.settings.enabledTools.includes('search_knowledge_base')) {
    merged.settings = { ...merged.settings, enabledTools: [...merged.settings.enabledTools, 'search_knowledge_base'] };
  }
}

// The removed MCP context auto-boost pinned context to 32768 (and maxTokens to 8192 /
// liteRTMaxTokens to 32768) on MCP enable and never restored it, causing OOM crashes
// and tanked tok/s on flagship devices. Reset anyone left at the boost ceiling back to
// the device-safe defaults. Idempotent: once reset, the values no longer match.
export const MCP_BOOST_CTX_CEILING = 32768;
const MCP_BOOST_MAX_OUTPUT_TOKENS = 8192;

export function migrateBoostedContext(
  merged: any,
  defaults: { contextLength: number; maxTokens: number; liteRTMaxTokens: number },
): void {
  const s = merged.settings;
  if (!s) return;
  // Match the EXACT values the boost wrote, not `>=`. The boost set these to
  // precise constants; a `>=` test also clobbers a user who legitimately chose a
  // large context/maxTokens above the default, which this one-time migration must
  // not touch.
  if (s.contextLength === MCP_BOOST_CTX_CEILING) {
    s.contextLength = defaults.contextLength;
    // maxTokens was raised alongside contextLength by the boost; only reset it when the
    // boost's exact value is present, so a legitimately-large user maxTokens isn't clobbered.
    if (s.maxTokens === MCP_BOOST_MAX_OUTPUT_TOKENS) s.maxTokens = defaults.maxTokens;
  }
  if (s.liteRTMaxTokens === MCP_BOOST_CTX_CEILING) {
    s.liteRTMaxTokens = defaults.liteRTMaxTokens;
  }
}

// Token sliders are hard-capped at MAX_TOKEN_LIMIT (128K). Clamp any persisted
// value left above the ceiling (e.g. from when model metadata drove the max)
// back down. Idempotent: values at or below the ceiling are untouched.
export function migrateTokenCeiling(merged: any): void {
  const s = merged.settings;
  if (!s) return;
  for (const key of TOKEN_CAPPED_KEYS) {
    if (typeof s[key] === 'number' && s[key] > MAX_TOKEN_LIMIT) s[key] = MAX_TOKEN_LIMIT;
  }
}

// Single choke point for the 128K slider ceiling: any live settings write above
// MAX_TOKEN_LIMIT is clamped, so sliders and loaders never see an over-ceiling
// value. Values at/below the ceiling (and non-numbers) pass through untouched.
export function clampTokenSettings<T extends object>(patch: T): T {
  const clamped = { ...patch } as Record<string, unknown>;
  for (const key of TOKEN_CAPPED_KEYS) {
    const v = clamped[key];
    if (typeof v === 'number' && v > MAX_TOKEN_LIMIT) clamped[key] = MAX_TOKEN_LIMIT;
  }
  return clamped as T;
}
