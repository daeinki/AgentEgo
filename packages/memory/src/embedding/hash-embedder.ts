import { createHash } from 'node:crypto';
import type { EmbeddingProvider } from './types.js';

const DEFAULT_DIMENSIONS = 128;

/**
 * Deterministic, offline embedding provider.
 *
 * The strategy: hash each **token** (lowercased word / CJK char) with SHA-256,
 * project into a fixed-dimensional vector by summing one-hot contributions at
 * `hash % dimensions`, then L2-normalize. Semantically this is a hashed
 * bag-of-words (random-projection style) — crude, but enough to let tests
 * exercise the hybrid-search merge logic, and stable across runs.
 *
 * Real deployments replace this with `AnthropicEmbedder` / `OpenAIEmbedder`
 * etc., which share the EmbeddingProvider contract.
 */
export class HashEmbedder implements EmbeddingProvider {
  public readonly dimensions: number;
  public readonly id = 'hash-embedder-v1';

  constructor(dimensions: number = DEFAULT_DIMENSIONS) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(this.dimensions);
    const tokens = tokenize(text);
    if (tokens.length === 0) return vec;

    for (const token of tokens) {
      const hash = createHash('sha256').update(token).digest();
      // Use two different slots per token: one positive, one negative sign.
      const idxA = hash.readUInt32BE(0) % this.dimensions;
      const idxB = hash.readUInt32BE(4) % this.dimensions;
      vec[idxA]! += 1;
      vec[idxB]! += 0.5;
    }

    // L2-normalize.
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i += 1) {
      vec[i]! /= norm;
    }
    return vec;
  }
}

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const words = lower.match(/[a-z0-9]+/g) ?? [];
  const cjk = lower.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g) ?? [];
  return [...words, ...cjk];
}

/**
 * Cosine similarity between two equal-length vectors. Returns a value in [-1, 1].
 * Tolerates Float32Array vs number[] by coercing.
 */
export function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
