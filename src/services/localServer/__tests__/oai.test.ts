/**
 * oai helpers — pure protocol logic: auth gating, admission, sampling split,
 * message normalization, SSE framing, fixed payloads.
 */
import {
  admitOrReject,
  chatChunkEnvelope,
  formatSSEChunk,
  isAuthorizedRequest,
  modelLoadingBody,
  modelsListPayload,
  normalizeChatMessages,
  splitSamplingParams,
  SSE_DONE,
} from '../oai';

describe('localServer oai helpers', () => {
  describe('isAuthorizedRequest', () => {
    it('leaves /health public even with a key set', () => {
      expect(isAuthorizedRequest('/health', null, 'secret')).toBe(true);
    });

    it('opens all routes when no key is configured', () => {
      expect(isAuthorizedRequest('/v1/chat/completions', null, '')).toBe(true);
    });

    it('rejects missing and wrong bearers when a key is set', () => {
      expect(isAuthorizedRequest('/v1/models', null, 'secret')).toBe(false);
      expect(isAuthorizedRequest('/v1/models', 'Bearer wrong', 'secret')).toBe(false);
    });

    it('accepts the exact bearer key', () => {
      expect(isAuthorizedRequest('/v1/models', 'Bearer secret', 'secret')).toBe(true);
    });
  });

  describe('admitOrReject', () => {
    it('admits below depth and rejects at depth with Retry-After', () => {
      expect(admitOrReject(0, 4)).toEqual({ admitted: true, retryAfterSec: 0 });
      expect(admitOrReject(3, 4).admitted).toBe(true);
      expect(admitOrReject(4, 4)).toEqual({ admitted: false, retryAfterSec: 5 });
    });
  });

  describe('splitSamplingParams', () => {
    it('keeps the common subset and lists exotics as ignored', () => {
      const { common, ignored } = splitSamplingParams({
        temperature: 0.5,
        top_p: 0.9,
        stream: true,
        dry_multiplier: 1.2,
        mirostat_tau: 5,
        grammar: 'root ::= "x"',
      });
      expect(common).toEqual({ temperature: 0.5, top_p: 0.9 });
      expect(ignored.sort()).toEqual(['dry_multiplier', 'grammar', 'mirostat_tau']);
    });
  });

  describe('normalizeChatMessages', () => {
    it('passes plain text turns through', () => {
      expect(
        normalizeChatMessages([{ role: 'user', content: 'hi' }]),
      ).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('throws on empty arrays, bad roles, and non-string content', () => {
      expect(() => normalizeChatMessages([])).toThrow();
      expect(() => normalizeChatMessages([{ role: 'tool', content: 'x' }])).toThrow();
      expect(() =>
        normalizeChatMessages([{ role: 'user', content: [{ type: 'image' }] }]),
      ).toThrow();
    });
  });

  describe('SSE framing', () => {
    it('frames chunks as data lines and ends with [DONE]', () => {
      expect(formatSSEChunk({ a: 1 })).toBe('data: {"a":1}\n\n');
      expect(SSE_DONE).toBe('data: [DONE]\n\n');
      const chunk = chatChunkEnvelope({ model: 'm', delta: 'hi', id: 'id-1', created: 123 }) as {
        choices: { delta: { content: string } }[];
      };
      expect(chunk.choices[0].delta.content).toBe('hi');
    });

    it('lists the single loaded model and reports loading as 503-shaped', () => {
      const list = modelsListPayload('model-abc') as { data: { id: string }[] };
      expect(list.data).toHaveLength(1);
      expect(list.data[0].id).toBe('model-abc');
      expect(JSON.stringify(modelLoadingBody())).toContain('model loading');
    });
  });
});
