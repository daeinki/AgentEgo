import { describe, it, expect } from 'vitest';
import { chunkText, estimateTokenCount } from './chunker.js';

describe('chunkText', () => {
  it('returns a single chunk for short input', () => {
    const chunks = chunkText('hi there');
    expect(chunks).toHaveLength(1);
  });

  it('splits at approximately the target token budget', () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const chunks = chunkText(long, { targetTokens: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    // none should blow far past the budget
    for (const c of chunks) {
      expect(estimateTokenCount(c)).toBeLessThan(80);
    }
  });

  it('preserves whole lines within a chunk', () => {
    const text = 'line one\nline two\nline three';
    const chunks = chunkText(text, { targetTokens: 4 });
    for (const c of chunks) {
      // no chunk should start mid-line
      expect(c.startsWith(' ')).toBe(false);
    }
  });

  it('empty input → empty result', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('  \n  ')).toEqual([]);
  });
});

describe('estimateTokenCount', () => {
  it('counts words', () => {
    expect(estimateTokenCount('one two three')).toBeGreaterThanOrEqual(3);
  });
  it('counts CJK characters', () => {
    expect(estimateTokenCount('안녕하세요')).toBeGreaterThanOrEqual(2);
  });
});
