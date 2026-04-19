import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  HttpEmbedder,
  openAIEmbedder,
  voyageEmbedder,
  ollamaEmbedder,
} from './http-embedder.js';

function mockFetchJson(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: async () => body,
      text: async () => JSON.stringify(body),
    })) as unknown as typeof fetch,
  );
}

describe('HttpEmbedder', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts to the configured endpoint and parses the embedding', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        data: [{ embedding: new Array(8).fill(0.1), index: 0 }],
      }),
      text: async () => '',
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const emb = new HttpEmbedder({
      endpoint: 'https://example.com/embeddings',
      model: 'test',
      dimensions: 8,
      apiKey: 'sekrit',
    });
    const vec = await emb.embed('hello');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(8);
    expect(vec[0]).toBeCloseTo(0.1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe('https://example.com/embeddings');
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sekrit');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(String(init.body));
    expect(body.input).toBe('hello');
    expect(body.model).toBe('test');
  });

  it('omits Authorization when no apiKey is supplied', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data: [{ embedding: new Array(4).fill(0), index: 0 }] }),
      text: async () => '',
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const emb = new HttpEmbedder({
      endpoint: 'http://local/embed',
      model: 'm',
      dimensions: 4,
    });
    await emb.embed('x');
    const headers = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('throws on non-2xx responses with status + body excerpt', async () => {
    mockFetchJson({ error: 'rate limit' }, 429);
    const emb = new HttpEmbedder({
      endpoint: 'http://local/embed',
      model: 'm',
      dimensions: 4,
    });
    await expect(emb.embed('x')).rejects.toThrow(/HTTP 429/);
  });

  it('throws when returned dimension does not match the declared size', async () => {
    mockFetchJson({ data: [{ embedding: new Array(3).fill(0), index: 0 }] });
    const emb = new HttpEmbedder({
      endpoint: 'http://local/embed',
      model: 'm',
      dimensions: 4,
    });
    await expect(emb.embed('x')).rejects.toThrow(/dimension mismatch/);
  });

  it('short-circuits for empty input without calling fetch', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const emb = new HttpEmbedder({
      endpoint: 'http://local/embed',
      model: 'm',
      dimensions: 4,
    });
    const vec = await emb.embed('');
    expect(vec.length).toBe(4);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('augmentRequest can inject provider-specific fields', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data: [{ embedding: new Array(4).fill(0), index: 0 }] }),
      text: async () => '',
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const emb = new HttpEmbedder({
      endpoint: 'http://local/embed',
      model: 'm',
      dimensions: 4,
      augmentRequest: (body) => ({ ...body, input_type: 'document' }),
    });
    await emb.embed('x');
    const body = JSON.parse(String((fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body));
    expect(body.input_type).toBe('document');
  });

  it('providerId defaults derive from host + model', () => {
    const emb = new HttpEmbedder({
      endpoint: 'https://api.example.com/v1/embed',
      model: 'foo-1',
      dimensions: 4,
    });
    expect(emb.id).toBe('http:api.example.com/foo-1');
  });
});

describe('factory helpers', () => {
  it('openAIEmbedder points at the OpenAI endpoint and sets dimensions body param', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data: [{ embedding: new Array(512).fill(0.01), index: 0 }] }),
      text: async () => '',
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const emb = openAIEmbedder({ apiKey: 'sk-x', dimensions: 512 });
    await emb.embed('hi');
    const call = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe('https://api.openai.com/v1/embeddings');
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body.dimensions).toBe(512);
    expect(emb.id).toBe('openai/text-embedding-3-small');
  });

  it('voyageEmbedder includes input_type when provided', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data: [{ embedding: new Array(1024).fill(0), index: 0 }] }),
      text: async () => '',
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const emb = voyageEmbedder({ apiKey: 'v-1', inputType: 'query' });
    await emb.embed('hi');
    const body = JSON.parse(
      String(((fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body),
    );
    expect(body.input_type).toBe('query');
  });

  it('ollamaEmbedder targets the local daemon by default', () => {
    const emb = ollamaEmbedder({ model: 'nomic-embed-text', dimensions: 768 });
    expect(emb.id).toBe('ollama/nomic-embed-text');
  });
});
