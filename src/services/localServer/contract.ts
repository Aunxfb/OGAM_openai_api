/**
 * LocalServer native contract — the ONE typed interface both native modules
 * (Android Kotlin + iOS Swift) must satisfy. Same method names, same events,
 * same payloads, same semantics (persistence, cleanup, error cascading).
 *
 * A method that exists on one platform but not the other is a contract
 * violation, not an acceptable difference. Genuine gaps are capability flags
 * on the status payload, never a missing method or a runtime
 * "only available on X" throw.
 */
import { NativeModules, NativeEventEmitter, Platform } from 'react-native';
import type {
  LocalServerConfig,
  LocalServerStatus,
  LocalServerCapabilities,
} from './types';
import { isValidLocalServerPort } from './types';

export const LOCAL_SERVER_MODULE_NAME = 'LocalServerModule';

/** Event names — identical on both natives. */
export const LOCAL_SERVER_STATUS_EVENT = 'LocalServerStatus';
export const LOCAL_SERVER_ERROR_EVENT = 'LocalServerError';
/**
 * Emitted by native once per admitted inference request. JS answers through
 * `respondToLocalServerRequest` (single JSON) or the `sendLocalServerChunk` /
 * `finishLocalServerStream` pair (SSE). The socket thread blocks until JS
 * answers, so handlers must always settle (the service fail-closes).
 */
export const LOCAL_SERVER_REQUEST_EVENT = 'LocalServerRequest';

export interface LocalServerNativeStatus extends LocalServerStatus {
  capabilities: LocalServerCapabilities;
}

/** One admitted HTTP request handed to JS for inference. */
export interface LocalServerNativeRequest {
  requestId: string;
  method: string;
  /** Path without the query string (native strips `?...`). */
  path: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** Raw request body (may be empty). */
  body: string;
}

/** One final HTTP response handed back to native for writing. */
export interface LocalServerFinalResponse {
  status: number;
  body: string;
  contentType?: string;
  extraHeaders?: Record<string, string>;
}

export interface LocalServerNativeModule {
  start(config: LocalServerConfig): Promise<LocalServerNativeStatus>;
  stop(): Promise<void>;
  getStatus(): Promise<LocalServerNativeStatus>;
  /**
   * Answer an admitted request with one final response. Native writes it and
   * closes the connection. Always resolves (never rejects for unknown ids).
   */
  respondToRequest(
    requestId: string,
    status: number,
    body: string,
    contentType?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<void>;
  /** Append one SSE payload (`data: {...}\n\n`) to an open stream. */
  sendChunk(requestId: string, sseData: string): Promise<void>;
  /** End an open SSE stream (`data: [DONE]` is written by native) + close. */
  finishStream(requestId: string): Promise<void>;
  /** SHA-256 fingerprint of the served self-signed cert, or null when TLS is
   *  off / BYOC. Shown in the UI so clients can pin trust. */
  getCertificateFingerprint(): Promise<string | null>;
  /** Delete + regenerate the persisted self-signed identity. Resolves with
   *  the new fingerprint. Takes effect on the next start. */
  regenerateCertificate(): Promise<string>;
  /**
   * True when the app was opened from the server notification (tap opens the
   * Local Server screen — consumed once by the screen on mount).
   */
  consumePendingOpenRequest(): Promise<boolean>;
}

function getNativeModule(): LocalServerNativeModule | null {
  const mod = NativeModules[LOCAL_SERVER_MODULE_NAME] as
    | LocalServerNativeModule
    | undefined;
  if (!mod?.start || !mod?.stop || !mod?.getStatus) return null;
  return mod;
}

function getFullNativeModule(): LocalServerNativeModule | null {
  const mod = getNativeModule();
  if (!mod?.respondToRequest || !mod?.sendChunk || !mod?.finishStream) {
    return null;
  }
  return mod;
}

/**
 * Fail-closed config validation in JS before touching native: bad port or
 * bad cert paths never reach the socket. The native side re-validates and
 * fails closed as well (defense in depth, not duplication of truth — the
 * range constants live in types.ts).
 */
export function validateLocalServerConfig(config: LocalServerConfig): void {
  if (!isValidLocalServerPort(config.port)) {
    throw new RangeError(
      `Local server port must be ${1024}-${65535} (got ${config.port})`,
    );
  }
  if (config.bindMode === 'interface' && !config.interfaceIp.trim()) {
    throw new Error(
      'Local server bind mode "interface" requires an interface IP',
    );
  }
  if (config.tlsMode === 'byoc' && (!config.certPath || !config.keyPath)) {
    throw new Error(
      'Local server TLS "byoc" mode requires both a cert and a key file',
    );
  }
  if (
    !Number.isInteger(config.queueDepth) ||
    config.queueDepth < 1 ||
    config.queueDepth > 32
  ) {
    throw new RangeError(
      `Local server queue depth must be 1-32 (got ${config.queueDepth})`,
    );
  }
}

export async function startLocalServerNative(
  config: LocalServerConfig,
): Promise<LocalServerNativeStatus> {
  validateLocalServerConfig(config);
  const mod = getNativeModule();
  if (!mod) throw new Error('Local server is not available on this build');
  return mod.start(config);
}

export async function stopLocalServerNative(): Promise<void> {
  const mod = getNativeModule();
  if (!mod) return;
  await mod.stop();
}

export async function getLocalServerNativeStatus(): Promise<LocalServerNativeStatus | null> {
  const mod = getNativeModule();
  if (!mod) return null;
  return mod.getStatus();
}

export function isLocalServerNativeAvailable(): boolean {
  return getNativeModule() !== null;
}

/**
 * Subscribe to native status/error/request events. All platforms emit the
 * same events with the same payloads. Returns an unsubscribe function.
 */
export function subscribeLocalServerEvents(handlers: {
  onStatus?: (status: LocalServerNativeStatus) => void;
  onError?: (message: string) => void;
  onRequest?: (request: LocalServerNativeRequest) => void;
}): () => void {
  const mod = NativeModules[LOCAL_SERVER_MODULE_NAME];
  if (!mod) return () => {};
  const emitter = new NativeEventEmitter(mod);
  const subs = [
    emitter.addListener(LOCAL_SERVER_STATUS_EVENT, (s: LocalServerNativeStatus) =>
      handlers.onStatus?.(s),
    ),
    emitter.addListener(LOCAL_SERVER_ERROR_EVENT, (e: { message?: string }) =>
      handlers.onError?.(e?.message ?? 'Unknown local server error'),
    ),
    emitter.addListener(LOCAL_SERVER_REQUEST_EVENT, (r: LocalServerNativeRequest) =>
      handlers.onRequest?.(r),
    ),
  ];
  return () => subs.forEach(s => s.remove());
}

/** Answer one admitted request with a final response (never throws). */
export async function respondToLocalServerRequest(
  requestId: string,
  response: LocalServerFinalResponse,
): Promise<void> {
  const mod = getFullNativeModule();
  if (!mod) return;
  await mod.respondToRequest(
    requestId,
    response.status,
    response.body,
    response.contentType ?? 'application/json',
    response.extraHeaders ?? {},
  );
}

/** Append one SSE payload to an open stream (never throws). */
export async function sendLocalServerChunk(
  requestId: string,
  sseData: string,
): Promise<void> {
  const mod = getFullNativeModule();
  if (!mod) return;
  await mod.sendChunk(requestId, sseData);
}

/** End an open SSE stream (never throws). */
export async function finishLocalServerStream(requestId: string): Promise<void> {
  const mod = getFullNativeModule();
  if (!mod) return;
  await mod.finishStream(requestId);
}

/** Served-cert fingerprint for the trust UI (null when unavailable). */
export async function getLocalServerFingerprint(): Promise<string | null> {
  const mod = getNativeModule();
  if (!mod?.getCertificateFingerprint) return null;
  try {
    return await mod.getCertificateFingerprint();
  } catch {
    return null;
  }
}

/** Regenerate the persisted self-signed identity. Null when unavailable. */
export async function regenerateLocalServerCertificate(): Promise<string | null> {
  const mod = getNativeModule();
  if (!mod?.regenerateCertificate) return null;
  try {
    return await mod.regenerateCertificate();
  } catch {
    return null;
  }
}

/** True once when the app was opened from the server notification. */
export async function consumeLocalServerOpenRequest(): Promise<boolean> {
  const mod = getNativeModule();
  if (!mod?.consumePendingOpenRequest) return false;
  try {
    return await mod.consumePendingOpenRequest();
  } catch {
    return false;
  }
}

/** Capability flags for the current platform — DATA, not branching. */
export function getLocalServerCapabilities(): LocalServerCapabilities {
  return {
    backgroundServe: Platform.OS === 'android',
    wakeLock: Platform.OS === 'android',
  };
}
