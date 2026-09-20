/**
 * LocalServer zustand slice — persisted config + live status projection.
 *
 * Pure reactive state only: the owning LocalServerService performs all
 * side-effects. Screens dispatch intents on the service and read this slice
 * for rendering. Extracted here (rather than inline in appStore.ts) so
 * appStore.ts stays under the repo's 500-line lint gate.
 */
import type { StateCreator } from 'zustand';
import type {
  LocalServerConfig,
  LocalServerStatus,
} from '../services/localServer/types';
import { DEFAULT_LOCAL_SERVER_CONFIG } from '../services/localServer/types';

export interface LocalServerSlice {
  /** Local llama-server config (persisted). */
  localServer: LocalServerConfig;
  setLocalServerConfig: (patch: Partial<LocalServerConfig>) => void;
  resetLocalServerConfig: () => void;
  /** Live server status projection (NOT persisted — a relaunch is stopped). */
  localServerStatus: LocalServerStatus;
  setLocalServerStatus: (status: Partial<LocalServerStatus>) => void;
}

export const INITIAL_LOCAL_SERVER_STATUS: LocalServerStatus = {
  running: false,
  urls: [],
  requestsServed: 0,
  lastError: null,
};

/**
 * Merge persisted localServer config over defaults (existing installs have
 * none persisted — they get defaults, not a crash).
 */
export function mergePersistedLocalServer(persisted: unknown): LocalServerConfig {
  if (!persisted || typeof persisted !== 'object') return { ...DEFAULT_LOCAL_SERVER_CONFIG };
  return { ...DEFAULT_LOCAL_SERVER_CONFIG, ...(persisted as Partial<LocalServerConfig>) };
}

export const createLocalServerSlice: StateCreator<any, [], [], LocalServerSlice> = (set, _get, _api) => ({
  localServer: { ...DEFAULT_LOCAL_SERVER_CONFIG },
  setLocalServerConfig: patch =>
    set((state: LocalServerSlice) => ({ localServer: { ...state.localServer, ...patch } })),
  resetLocalServerConfig: () => set({ localServer: { ...DEFAULT_LOCAL_SERVER_CONFIG } }),
  localServerStatus: { ...INITIAL_LOCAL_SERVER_STATUS },
  setLocalServerStatus: status =>
    set((state: LocalServerSlice) => ({
      localServerStatus: { ...state.localServerStatus, ...status },
    })),
});
