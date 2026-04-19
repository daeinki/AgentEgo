import { describe, it, expect } from 'vitest';
import { HashEmbedder, cosineSimilarity } from './hash-embedder.js';
import { encodeEmbedding, decodeEmbedding } from './types.js';

describe('HashEmbedder', () => {
  it('produces a fixed-dimensional vector', async () => {
    const e = new HashEmbedder(128);
    const vec = await e.embed('hello world');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(128);
  });

  it('is deterministic across runs', async () => {
    const e = new HashEmbedder();
    const a = await e.embed('TypeScript 코드 리뷰');
    const b = await e.embed('TypeScript 코드 리뷰');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('produces higher cosine similarity for related texts than unrelated', async () => {
    const e = new HashEmbedder();
    const a = await e.embed('TypeScript 배포 파이프라인 구성');
    const close = await e.embed('TypeScript 배포 설정');
    const far = await e.embed('쿠키 레시피와 베이킹');
    const closeSim = cosineSimilarity(a, close);
    const farSim = cosineSimilarity(a, far);
    expect(closeSim).toBeGreaterThan(farSim);
  });

  it('empty text yields a zero-similarity vector', async () => {
    const e = new HashEmbedder();
    const vec = await e.embed('');
    expect(vec.every((v) => v === 0)).toBe(true);
  });

  it('encode/decode round-trip preserves values', async () => {
    const e = new HashEmbedder();
    const vec = await e.embed('round trip');
    const buf = encodeEmbedding(vec);
    const back = decodeEmbedding(buf);
    for (let i = 0; i < vec.length; i += 1) {
      expect(back[i]).toBeCloseTo(vec[i]!, 5);
    }
  });
});

describe('cosineSimilarity', () => {
  it('identical vectors → 1', () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
  });

  it('orthogonal vectors → 0', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('mismatched lengths → 0', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
});
