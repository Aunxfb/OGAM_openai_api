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

export interface LocalServerNativeStatus extends LocalServerStatus {
  capabilities: LocalServerCapabilities;
}

export interface LocalServerNativeModule {
  start(config: LocalServerConfig): Promise<LocalServerNativeStatus>;
  stop(): Promise<void>;
  getStatus(): Promise<LocalServerNativeStatus>;
}

function getNativeModule(): LocalServerNativeModule | null {
  const mod = NativeModules[LOCAL_SERVER_MODULE_NAME] as
    | LocalServerNativeModule
    | undefined;
  if (!mod?.start || !mod?.stop || !mod?.getStatus) return null;
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
 * Subscribe to native status/error events. Both platforms emit the same two
 * events with the same payloads. Returns an unsubscribe function.
 */
export function subscribeLocalServerEvents(handlers: {
  onStatus?: (status: LocalServerNativeStatus) => void;
  onError?: (message: string) => void;
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
  ];
  return () => subs.forEach(s => s.remove());
}

/** Capability flags for the current platform — DATA, not branching. */
export function getLocalServerCapabilities(): LocalServerCapabilities {
  return {
    backgroundServe: Platform.OS === 'android',
    wakeLock: Platform.OS === 'android',
  };
}
