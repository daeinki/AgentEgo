import type { EmbeddingProvider } from './types.js';

/**
 * HTTP embedder compatible with the OpenAI `/v1/embeddings` API shape. Works
 * with OpenAI, Voyage, Ollama (embedding-enabled models), and any other
 * provider that implements the same request/response contract.
 *
 * Request body:
 *   { "input": "<text>", "model": "<model-id>", ... }
 *
 * Response body:
 *   { "data": [ { "embedding": number[], "index": 0 } ], "model": "...", ... }
 */
export interface HttpEmbedderConfig {
  /**
   * Full URL of the embeddings endpoint, e.g.
   *   https://api.openai.com/v1/embeddings
   *   http://localhost:11434/v1/embeddings  (Ollama)
   *   https://api.voyageai.com/v1/embeddings
   */
  endpoint: string;
  model: string;
  apiKey?: string;
  dimensions: number;
  /**
   * Identifier used to tag stored embeddings so we can detect a model change.
   * Defaults to `${provider}/${model}`.
   */
  providerId?: string;
  /**
   * Optional request timeout (default 30s).
   */
  timeoutMs?: number;
  /**
   * Optional additional headers, merged with Authorization + Content-Type.
   */
  headers?: Record<string, string>;
  /**
   * Optional request shaper — lets callers add provider-specific fields
   * (e.g. Voyage's `input_type`).
   */
  augmentRequest?: (body: Record<string, unknown>) => Record<string, unknown>;
}

interface EmbeddingsResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model?: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

export class HttpEmbedder implements EmbeddingProvider {
  readonly dimensions: number;
  readonly id: string;
  private readonly config: HttpEmbedderConfig & { timeoutMs: number };

  constructor(config: HttpEmbedderConfig) {
    this.dimensions = config.dimensions;
    this.id = config.providerId ?? `http:${new URL(config.endpoint).host}/${config.model}`;
    this.config = {
      ...config,
      timeoutMs: config.timeoutMs ?? 30_000,
    };
  }

  async embed(text: string): Promise<Float32Array> {
    if (text.length === 0) return new Float32Array(this.dimensions);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      let body: Record<string, unknown> = {
        input: text,
        model: this.config.model,
      };
      if (this.config.augmentRequest) {
        body = this.config.augmentRequest(body);
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(this.config.headers ?? {}),
      };
      if (this.config.apiKey) {
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      }

      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(
          `embedding request failed: HTTP ${response.status} ${response.statusText}${errText ? ` — ${errText.slice(0, 200)}` : ''}`,
        );
      }

      const json = (await response.json()) as EmbeddingsResponse;
      const first = json.data?.[0]?.embedding;
      if (!first || !Array.isArray(first)) {
        throw new Error('embedding response missing data[0].embedding');
      }
      if (first.length !== this.dimensions) {
        throw new Error(
          `embedding dimension mismatch: expected ${this.dimensions}, got ${first.length}`,
        );
      }
      return new Float32Array(first);
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ─── Convenience factories ───────────────────────────────────────────────────

export function openAIEmbedder(opts: {
  apiKey: string;
  model?: string;
  dimensions?: number;
}): HttpEmbedder {
  const model = opts.model ?? 'text-embedding-3-small';
  const dim = opts.dimensions ?? 1536;
  return new HttpEmbedder({
    endpoint: 'https://api.openai.com/v1/embeddings',
    model,
    apiKey: opts.apiKey,
    dimensions: dim,
    providerId: `openai/${model}`,
    // text-embedding-3-* supports explicit dimension reduction; include it when
    // the caller wants something smaller than the native size.
    augmentRequest: (body) => ({ ...body, dimensions: dim }),
  });
}

export function voyageEmbedder(opts: {
  apiKey: string;
  model?: string;
  dimensions?: number;
  inputType?: 'query' | 'document';
}): HttpEmbedder {
  const model = opts.model ?? 'voyage-3';
  const dim = opts.dimensions ?? 1024;
  return new HttpEmbedder({
    endpoint: 'https://api.voyageai.com/v1/embeddings',
    model,
    apiKey: opts.apiKey,
    dimensions: dim,
    providerId: `voyage/${model}`,
    augmentRequest: (body) => ({
      ...body,
      ...(opts.inputType ? { input_type: opts.inputType } : {}),
    }),
  });
}

export function ollamaEmbedder(opts: {
  baseUrl?: string;
  model: string;
  dimensions: number;
}): HttpEmbedder {
  const base = opts.baseUrl ?? 'http://localhost:11434';
  return new HttpEmbedder({
    endpoint: `${base.replace(/\/$/, '')}/v1/embeddings`,
    model: opts.model,
    dimensions: opts.dimensions,
    providerId: `ollama/${opts.model}`,
  });
}
