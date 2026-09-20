/**
 * LocalServer types — the SINGLE definition of the on-device llama-server
 * config + status shapes. Both native modules (Kotlin + Swift) and the owning
 * LocalServerService speak these shapes; nothing redefines them elsewhere.
 */

export type LocalServerBindMode = 'loopback' | 'interface' | 'all';

export type LocalServerTlsMode = 'off' | 'byoc' | 'self-signed';

export interface LocalServerConfig {
  enabled: boolean;
  port: number;
  bindMode: LocalServerBindMode;
  /** Only used when bindMode === 'interface'. Empty otherwise. */
  interfaceIp: string;
  tlsMode: LocalServerTlsMode;
  /** BYOC only: file paths to the PEM cert + key. Empty otherwise. */
  certPath: string;
  keyPath: string;
  /** Optional single Bearer key. Empty = no auth (health stays public either way). */
  apiKey: string;
  /** FIFO depth before the server answers 503 + Retry-After. */
  queueDepth: number;
}

export interface LocalServerStatus {
  running: boolean;
  /** Reachable base URL(s), e.g. ["http://127.0.0.1:8080"]. Empty when stopped. */
  urls: string[];
  requestsServed: number;
  lastError: string | null;
}

/** Genuine OS capability gaps are declared DATA, never `if (ios)` in callers. */
export interface LocalServerCapabilities {
  /** iOS suspends background sockets ~30s after backgrounding. Always false on iOS. */
  backgroundServe: boolean;
  /** Whether the platform can hold a CPU wakelock for serving with screen off. */
  wakeLock: boolean;
}

export const DEFAULT_LOCAL_SERVER_CONFIG: LocalServerConfig = {
  enabled: false,
  port: 8080,
  bindMode: 'loopback',
  interfaceIp: '',
  tlsMode: 'off',
  certPath: '',
  keyPath: '',
  apiKey: '',
  queueDepth: 4,
};

export const MIN_LOCAL_SERVER_PORT = 1024;
export const MAX_LOCAL_SERVER_PORT = 65535;

export function isValidLocalServerPort(port: number): boolean {
  return (
    Number.isInteger(port) &&
    port >= MIN_LOCAL_SERVER_PORT &&
    port <= MAX_LOCAL_SERVER_PORT
  );
}
