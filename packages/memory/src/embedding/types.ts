export interface EmbeddingProvider {
  readonly dimensions: number;
  /**
   * Produce a fixed-length float embedding for the given text. Implementations
   * may batch internally; the public API is single-string for simplicity.
   */
  embed(text: string): Promise<Float32Array>;
  /**
   * A short identifier for the provider/model combination. Stored alongside
   * embeddings so we can detect a model switch and trigger re-embedding.
   */
  readonly id: string;
}

/**
 * Encode a Float32Array to a Buffer suitable for SQLite BLOB storage.
 */
export function encodeEmbedding(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Decode an SQLite BLOB back into a Float32Array.
 */
export function decodeEmbedding(buf: Buffer | Uint8Array): Float32Array {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  // Copy out so the caller isn't affected by buffer churn.
  const out = new Float32Array(bytes.byteLength / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}
