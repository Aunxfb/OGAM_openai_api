import {
  chatListPreviewLine,
  preprocessChatMarkdown,
  safeChatExternalUrl,
} from '../../../src/vendor/shared';

describe('vendor/shared (no ../shared dependency)', () => {
  describe('chatListPreviewLine', () => {
    it('prefixes user messages with "You: "', () => {
      expect(chatListPreviewLine('user', 'My question')).toBe('You: My question');
    });

    it('leaves assistant messages bare', () => {
      expect(chatListPreviewLine('assistant', 'Here is the answer')).toBe(
        'Here is the answer',
      );
    });

    it('collapses newlines and extra whitespace to one line', () => {
      expect(chatListPreviewLine('assistant', 'line one\n```\ncode\n```')).toBe(
        'line one ``` code ```',
      );
    });

    it('cuts long replies instead of blowing the row apart', () => {
      const long = `a${'b'.repeat(200)}`;
      const out = chatListPreviewLine('assistant', long);
      expect(out.length).toBeLessThan(long.length);
      expect(out.endsWith('…')).toBe(true);
    });

    it('returns empty string when there is nothing to summarise', () => {
      expect(chatListPreviewLine('assistant', '')).toBe('');
      expect(chatListPreviewLine(undefined, undefined)).toBe('');
    });
  });

  describe('preprocessChatMarkdown', () => {
    it('escapes digit*digit multiplication chains', () => {
      expect(preprocessChatMarkdown('Result: 5*5*5*5')).toBe(
        String.raw`Result: 5\*5\*5\*5`,
      );
    });

    it('leaves intentional emphasis alone', () => {
      expect(preprocessChatMarkdown('This is *important* text')).toBe(
        'This is *important* text',
      );
    });
  });

  describe('safeChatExternalUrl', () => {
    it('allows http and https links', () => {
      expect(safeChatExternalUrl('https://example.com/x')).toBe(
        'https://example.com/x',
      );
      expect(safeChatExternalUrl('http://example.com')).toBe(
        'http://example.com',
      );
    });

    it('refuses deep links, javascript: and garbage', () => {
      expect(safeChatExternalUrl('javascript:alert(1)')).toBeNull();
      expect(safeChatExternalUrl('myapp://open')).toBeNull();
      expect(safeChatExternalUrl('not a url')).toBeNull();
      expect(safeChatExternalUrl('')).toBeNull();
    });
  });
});
