/**
 * liteRTService publishes its effective context window to the store on load
 * (and clears it on unload) so the Max Tokens slider caps at what the loaded
 * session supports — mirroring the llama path. Fakes ONLY at the native
 * boundary (installNativeBoundary); the real service + real store run.
 */
import { installNativeBoundary } from '../../harness/nativeBoundary';

describe('liteRTService modelMaxContext', () => {
  it('publishes the native-effective context on load and clears on unload', async () => {
    installNativeBoundary();
    const { liteRTService } = require('../../../src/services/litert');
    const { useAppStore } = require('../../../src/stores/appStore');

    expect(useAppStore.getState().modelMaxContext).toBeNull();

    // The native fake clamps to 4096 regardless of the 8192 requested — the
    // store must carry the EFFECTIVE value, not the request.
    await liteRTService.loadModel('/m', 'gpu', { maxNumTokens: 8192 });
    expect(useAppStore.getState().modelMaxContext).toBe(4096);

    await liteRTService.unloadModel();
    expect(useAppStore.getState().modelMaxContext).toBeNull();
  });
});
