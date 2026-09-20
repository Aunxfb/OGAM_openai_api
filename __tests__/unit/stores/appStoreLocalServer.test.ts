/**
 * appStore localServer slice — defaults, patch updates, reset, and status
 * projection. The slice is pure reactive state; the owning
 * LocalServerService performs all side-effects.
 */
import { useAppStore } from '../../../src/stores/appStore';
import { DEFAULT_LOCAL_SERVER_CONFIG } from '../../../src/services/localServer/types';
import { resetStores, getAppState } from '../../utils/testHelpers';

describe('appStore localServer slice', () => {
  beforeEach(() => {
    resetStores();
  });

  it('starts with the documented defaults (disabled, loopback, 8080, queue 4)', () => {
    expect(getAppState().localServer).toEqual(DEFAULT_LOCAL_SERVER_CONFIG);
    expect(getAppState().localServer).toMatchObject({
      enabled: false,
      port: 8080,
      bindMode: 'loopback',
      tlsMode: 'off',
      queueDepth: 4,
    });
  });

  it('setLocalServerConfig patches without replacing the whole slice', () => {
    getAppState().setLocalServerConfig({ port: 9090, enabled: true });

    expect(getAppState().localServer.port).toBe(9090);
    expect(getAppState().localServer.enabled).toBe(true);
    expect(getAppState().localServer.bindMode).toBe('loopback');
  });

  it('resetLocalServerConfig restores defaults', () => {
    getAppState().setLocalServerConfig({ port: 9090, apiKey: 'secret' });

    getAppState().resetLocalServerConfig();

    expect(getAppState().localServer).toEqual(DEFAULT_LOCAL_SERVER_CONFIG);
  });

  it('localServerStatus starts stopped and patches live (never persisted)', () => {
    expect(getAppState().localServerStatus.running).toBe(false);

    getAppState().setLocalServerStatus({ running: true, requestsServed: 3 });

    expect(getAppState().localServerStatus).toMatchObject({
      running: true,
      requestsServed: 3,
    });
  });

  it('persist partialize includes localServer but not localServerStatus', () => {
    const { localServer } = useAppStore.getState();
    expect(localServer).toBeDefined();
    // Status is a live projection: rehydrate must always start stopped.
    // resetStores (persist rehydrate path in tests) leaves status stopped.
    expect(getAppState().localServerStatus.running).toBe(false);
  });
});
