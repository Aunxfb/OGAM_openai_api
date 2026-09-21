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
import type { LocalServerNativeRequest, LocalServerNativeStatus } from '../contract';

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
    respond: async (requestId, response) => {
      calls.push(`respond:${requestId}:${response.status}`);
    },
    sendChunk: async requestId => {
      calls.push(`chunk:${requestId}`);
    },
    finishStream: async requestId => {
      calls.push(`finish:${requestId}`);
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

describe('LocalServerService.handleNativeRequest', () => {
  interface Captured {
    requestId: string;
    status: number;
    body: string;
  }

  function req(partial: Partial<LocalServerNativeRequest>): LocalServerNativeRequest {
    return {
      requestId: 'req-1',
      method: 'GET',
      path: '/health',
      headers: {},
      body: '',
      ...partial,
    };
  }

  async function runningService(opts?: {
    generate?: (messages: unknown[], onToken?: (t: string) => void) => Promise<string>;
    tokenize?: (text: string) => Promise<number[]>;
    detokenize?: (tokens: number[]) => Promise<string>;
  }): Promise<{ svc: LocalServerService; responses: Captured[]; chunks: string[]; finishes: string[] }> {
    const responses: Captured[] = [];
    const chunks: string[] = [];
    const finishes: string[] = [];
    const bridge: LocalServerBridge = {
      startNative: async () => runningStatus(),
      stopNative: async () => {},
      subscribeEvents: () => () => {},
      respond: async (requestId, response) => {
        responses.push({ requestId, status: response.status, body: response.body });
      },
      sendChunk: async (requestId, sseData) => {
        chunks.push(`${requestId}:${sseData}`);
      },
      finishStream: async requestId => {
        finishes.push(requestId);
      },
    };
    const svc = new LocalServerService(
      bridge,
      (opts?.generate as never) ?? (async () => 'hello'),
      {
        tokenize: opts?.tokenize ?? (async () => [1, 2]),
        detokenize: opts?.detokenize ?? (async () => 'hi'),
      },
    );
    await svc.start();
    return { svc, responses, chunks, finishes };
  }

  beforeEach(() => {
    resetStores();
  });

  it('answers 503 when the service is not running', async () => {
    const { svc, responses } = await runningService();
    await svc.stop();
    await svc.handleNativeRequest(req({}));

    expect(responses).toHaveLength(1);
    expect(responses[0].status).toBe(503);
  });

  it('answers health publicly with status ok', async () => {
    const { svc, responses } = await runningService();
    await svc.handleNativeRequest(req({}));

    expect(responses[0].status).toBe(200);
    expect(JSON.parse(responses[0].body)).toEqual({ status: 'ok' });
  });

  it('rejects gated routes without the Bearer key', async () => {
    const { svc, responses } = await runningService();
    useAppStore.getState().setLocalServerConfig({ apiKey: 'secret' });
    await svc.handleNativeRequest(req({ method: 'GET', path: '/v1/models' }));

    expect(responses[0].status).toBe(401);
  });

  it('serves the loaded model id on /v1/models and 503 in transition', async () => {
    const { svc, responses } = await runningService();
    useAppStore.getState().setLoadedTextModelId(null);
    await svc.handleNativeRequest(req({ method: 'GET', path: '/v1/models' }));
    expect(responses[0].status).toBe(503);

    useAppStore.getState().setLoadedTextModelId('model-abc');
    await svc.handleNativeRequest(req({ method: 'GET', path: '/v1/models', requestId: 'req-2' }));
    expect(responses[1].status).toBe(200);
    const body = JSON.parse(responses[1].body);
    expect(body.data[0].id).toBe('model-abc');
  });

  it('answers a non-streaming chat completion with the envelope', async () => {
    const { svc, responses } = await runningService();
    useAppStore.getState().setLoadedTextModelId('model-abc');
    await svc.handleNativeRequest(
      req({
        method: 'POST',
        path: '/v1/chat/completions',
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      }),
    );

    expect(responses[0].status).toBe(200);
    const body = JSON.parse(responses[0].body);
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toBe('hello');
  });

  it('streams chat deltas as SSE chunks then finishes', async () => {
    const { svc, responses, chunks, finishes } = await runningService({
      generate: async (_messages, onToken) => {
        onToken?.('a');
        onToken?.('b');
        return 'ab';
      },
    });
    useAppStore.getState().setLoadedTextModelId('model-abc');
    await svc.handleNativeRequest(
      req({
        method: 'POST',
        path: '/v1/chat/completions',
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
      }),
    );

    expect(responses).toHaveLength(0);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('chat.completion.chunk');
    expect(finishes).toEqual(['req-1']);
  });

  it('answers 400 for invalid JSON and malformed messages', async () => {
    const { svc, responses } = await runningService();
    useAppStore.getState().setLoadedTextModelId('model-abc');
    await svc.handleNativeRequest(
      req({ method: 'POST', path: '/v1/chat/completions', body: 'not-json' }),
    );
    expect(responses[0].status).toBe(400);

    await svc.handleNativeRequest(
      req({
        method: 'POST',
        path: '/v1/chat/completions',
        body: JSON.stringify({ messages: [] }),
        requestId: 'req-2',
      }),
    );
    expect(responses[1].status).toBe(400);
  });

  it('serves tokenize and detokenize from the loaded context', async () => {
    const { svc, responses } = await runningService();
    useAppStore.getState().setLoadedTextModelId('model-abc');
    await svc.handleNativeRequest(
      req({ method: 'POST', path: '/tokenize', body: JSON.stringify({ content: 'hi' }) }),
    );
    expect(responses[0].status).toBe(200);
    expect(JSON.parse(responses[0].body)).toEqual({ tokens: [1, 2] });

    await svc.handleNativeRequest(
      req({ method: 'POST', path: '/detokenize', body: JSON.stringify({ tokens: [1, 2] }), requestId: 'req-2' }),
    );
    expect(responses[1].status).toBe(200);
    expect(JSON.parse(responses[1].body)).toEqual({ content: 'hi' });
  });

  it('answers 501 for embeddings and 404 for unknown routes', async () => {
    const { svc, responses } = await runningService();
    useAppStore.getState().setLoadedTextModelId('model-abc');
    await svc.handleNativeRequest(req({ method: 'POST', path: '/v1/embeddings' }));
    expect(responses[0].status).toBe(501);

    await svc.handleNativeRequest(req({ method: 'GET', path: '/props', requestId: 'req-2' }));
    expect(responses[1].status).toBe(404);
  });
});
