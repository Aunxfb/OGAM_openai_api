/**
 * LocalServerService — owning-service behavior: state machine, fail-closed
 * start, auth/admission/503 paths, and delegation. The ONLY fakes are the
 * native bridge (stands in for Kotlin/Swift at the device boundary) and the
 * token generator (stands in for the native inference engine); no app code
 * is mocked — store state is driven through the real setters.
 */
import { useAppStore } from '../../../stores/appStore';
import { resetStores } from '../../../../__tests__/utils/testHelpers';
import { LocalServerService, type LocalServerBridge } from '../LocalServerService';
import type { LocalServerNativeStatus } from '../contract';

function runningStatus(): LocalServerNativeStatus {
  return {
    running: true,
    urls: ['http://127.0.0.1:8080'],
    requestsServed: 0,
    lastError: null,
    capabilities: { backgroundServe: false, wakeLock: false },
  };
}

function makeBridge(overrides?: Partial<LocalServerBridge>): LocalServerBridge & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    startNative: async config => {
      calls.push(`start:${config.port}`);
      return runningStatus();
    },
    stopNative: async () => {
      calls.push('stop');
    },
    subscribeEvents: () => {
      calls.push('subscribe');
      return () => {};
    },
    ...overrides,
  };
}

describe('LocalServerService', () => {
  beforeEach(() => {
    resetStores();
  });

  it('starts from stopped, mirrors native status, and stops clean', async () => {
    const bridge = makeBridge();
    const svc = new LocalServerService(bridge);
    expect(svc.getState()).toBe('stopped');

    await svc.start();

    expect(svc.getState()).toBe('running');
    expect(useAppStore.getState().localServerStatus.urls).toEqual(['http://127.0.0.1:8080']);
    expect(useAppStore.getState().localServer.enabled).toBe(true);

    await svc.stop();

    expect(svc.getState()).toBe('stopped');
    expect(useAppStore.getState().localServerStatus.running).toBe(false);
    expect(bridge.calls).toEqual(['start:8080', 'subscribe', 'stop']);
  });

  it('fails closed on an invalid port without touching native', async () => {
    const bridge = makeBridge();
    const svc = new LocalServerService(bridge);
    useAppStore.getState().setLocalServerConfig({ port: 80 });

    await svc.start();

    expect(svc.getState()).toBe('error');
    expect(useAppStore.getState().localServerStatus.lastError).toContain('1024');
    expect(bridge.calls).toEqual([]);
  });

  it('lands in error when native rejects (e.g. EADDRINUSE)', async () => {
    const bridge = makeBridge({
      startNative: async () => {
        throw new Error('EADDRINUSE: port 8080 in use');
      },
    });
    const svc = new LocalServerService(bridge);

    await svc.start();

    expect(svc.getState()).toBe('error');
    expect(useAppStore.getState().localServerStatus.lastError).toContain('EADDRINUSE');
  });

  it('answers 503 while no model is loaded (transition window)', async () => {
    const svc = new LocalServerService(makeBridge(), async () => 'unreachable');

    const res = await svc.completeChat([{ role: 'user', content: 'hi' }], {});

    expect(res.status).toBe(503);
  });

  it('answers 400 for malformed messages even with a model loaded', async () => {
    useAppStore.getState().setLoadedTextModelId('model-abc');
    const svc = new LocalServerService(makeBridge(), async () => 'unreachable');

    const res = await svc.completeChat([{ role: 'user', content: 42 }], {});

    expect(res.status).toBe(400);
  });

  it('delegates to the engine and rejects over-depth callers with Retry-After', async () => {
    useAppStore.getState().setLoadedTextModelId('model-abc');
    useAppStore.getState().setLocalServerConfig({ queueDepth: 1 });
    let resolveFirst!: (v: string) => void;
    const gate = new Promise<string>(r => {
      resolveFirst = r;
    });
    const svc = new LocalServerService(makeBridge(), () => gate);

    const first = svc.completeChat([{ role: 'user', content: 'one' }], { temperature: 0.5 });
    const second = await svc.completeChat([{ role: 'user', content: 'two' }], {});

    expect(second.status).toBe(503);
    if (second.status === 503) expect(second.retryAfterSec).toBe(5);
    resolveFirst('hello');
    const done = await first;
    expect(done).toEqual({ status: 200, model: 'model-abc', text: 'hello' });
    expect(svc.getActiveRequests()).toBe(0);
  });

  it('gates routes by the configured key with health public', () => {
    const svc = new LocalServerService(makeBridge());
    useAppStore.getState().setLocalServerConfig({ apiKey: 'secret' });

    expect(svc.isAuthorized('/health', null)).toBe(true);
    expect(svc.isAuthorized('/v1/models', null)).toBe(false);
    expect(svc.isAuthorized('/v1/models', 'Bearer secret')).toBe(true);
  });
});
