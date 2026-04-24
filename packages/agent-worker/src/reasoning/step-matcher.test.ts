import { describe, it, expect } from 'vitest';
import {
  EmbedderStepMatcher,
  cosineSimilarity,
  type EmbedFn,
} from './step-matcher.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it('returns 0 when either vector is all zeros (no NaN)', () => {
    const zero = new Float32Array([0, 0, 0]);
    const v = new Float32Array([1, 1, 1]);
    expect(cosineSimilarity(zero, v)).toBe(0);
    expect(cosineSimilarity(v, zero)).toBe(0);
  });

  it('throws on length mismatch', () => {
    expect(() =>
      cosineSimilarity(new Float32Array([1, 2]), new Float32Array([1, 2, 3])),
    ).toThrow(/length mismatch/);
  });
});

/**
 * Deterministic synthetic embedder keyed by substring. Goals sharing a
 * keyword get the same vector; unique keywords get orthogonal bases. Lets
 * tests control similarity precisely without relying on HashEmbedder's
 * hash distribution.
 */
function keywordEmbed(keywords: Record<string, number[]>): EmbedFn {
  const dim = Object.values(keywords)[0]?.length ?? 4;
  return async (text: string) => {
    for (const [kw, vec] of Object.entries(keywords)) {
      if (text.includes(kw)) return new Float32Array(vec);
    }
    // Fallback: all-ones / dim — falls below any threshold against specific kws.
    const fallback = new Array(dim).fill(1 / Math.sqrt(dim));
    return new Float32Array(fallback);
  };
}

describe('EmbedderStepMatcher.match', () => {
  const KW = {
    list: [1, 0, 0, 0],
    summarize: [0, 1, 0, 0],
    fetch: [0, 0, 1, 0],
    irrelevant: [0, 0, 0, 1],
  };

  it('returns the best candidate id when similarity clears threshold', async () => {
    const m = new EmbedderStepMatcher(keywordEmbed(KW), { threshold: 0.85 });
    const result = await m.match('summarize the file', [
      { id: 'a', goal: 'list the files' },
      { id: 'b', goal: 'summarize the contents' },
      { id: 'c', goal: 'fetch remote data' },
    ]);
    expect(result).toBe('b');
  });

  it('returns null when nothing clears the threshold', async () => {
    const m = new EmbedderStepMatcher(keywordEmbed(KW), { threshold: 0.85 });
    const result = await m.match('summarize', [
      { id: 'a', goal: 'irrelevant branch' },
      { id: 'c', goal: 'fetch remote data' },
    ]);
    expect(result).toBeNull();
  });

  it('returns null on empty candidate list', async () => {
    const m = new EmbedderStepMatcher(keywordEmbed(KW));
    expect(await m.match('anything', [])).toBeNull();
  });

  it('lower threshold loosens matching', async () => {
    const fuzzy: EmbedFn = async (text) => {
      // Every text embeds to slightly-different variations of [1,1,1,1].
      const noise = text.length * 0.001;
      return new Float32Array([1, 1 - noise, 1, 1]);
    };
    const strict = new EmbedderStepMatcher(fuzzy, { threshold: 0.999999 });
    const lenient = new EmbedderStepMatcher(fuzzy, { threshold: 0.5 });
    const cands = [{ id: 'x', goal: 'longer text here' }];
    // With noise, strict rejects; lenient accepts.
    expect(await strict.match('a', cands)).toBeNull();
    expect(await lenient.match('a', cands)).toBe('x');
  });
});
