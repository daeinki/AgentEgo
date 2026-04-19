import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EgoLlmConfig } from '@agent-platform/core';
import { createEgoLlmAdapter } from './llm-adapter-factory.js';
import { AnthropicEgoLlmAdapter } from './llm-adapter.js';
import { OpenAiEgoLlmAdapter } from './llm-adapter-openai.js';
import { FallbackEgoLlmAdapter } from './llm-adapter-fallback.js';

const ENV_BACKUP = { ...process.env };

beforeEach(() => {
  process.env['_FACTORY_TEST_OPENAI'] = 'sk-openai-test';
  process.env['_FACTORY_TEST_ANTHROPIC'] = 'sk-anthropic-test';
});

afterEach(() => {
  process.env = { ...ENV_BACKUP };
});

const openaiCfg: EgoLlmConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  apiKey: '${_FACTORY_TEST_OPENAI}',
  temperature: 0.1,
  maxTokens: 1024,
};

const anthropicCfg: EgoLlmConfig = {
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
  apiKey: '${_FACTORY_TEST_ANTHROPIC}',
  temperature: 0.1,
  maxTokens: 1024,
};

describe('createEgoLlmAdapter', () => {
  it('returns an OpenAI adapter when provider=openai', async () => {
    const adapter = await createEgoLlmAdapter(openaiCfg);
    expect(adapter).toBeInstanceOf(OpenAiEgoLlmAdapter);
    expect(adapter.getModelInfo()).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      isFallback: false,
    });
  });

  it('returns an Anthropic adapter when provider=anthropic', async () => {
    const adapter = await createEgoLlmAdapter(anthropicCfg);
    expect(adapter).toBeInstanceOf(AnthropicEgoLlmAdapter);
    expect(adapter.getModelInfo().provider).toBe('anthropic');
  });

  it('composes a FallbackEgoLlmAdapter when fallback block is present', async () => {
    const adapter = await createEgoLlmAdapter({
      ...openaiCfg,
      fallback: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        apiKey: '${_FACTORY_TEST_ANTHROPIC}',
      },
    });
    expect(adapter).toBeInstanceOf(FallbackEgoLlmAdapter);
    const info = adapter.getModelInfo();
    expect(info.provider).toBe('openai');
    expect(info.isFallback).toBe(false);
  });

  it('throws on unknown provider', async () => {
    await expect(
      createEgoLlmAdapter({ ...openaiCfg, provider: 'xai' as never }),
    ).rejects.toThrow(/Unsupported ego.llm.provider: 'xai'/);
  });

  it('throws when primary apiKey references an unset env var', async () => {
    delete process.env['_FACTORY_TEST_OPENAI'];
    await expect(createEgoLlmAdapter(openaiCfg)).rejects.toThrow(
      /_FACTORY_TEST_OPENAI/,
    );
  });

  it('throws when fallback apiKey references an unset env var', async () => {
    delete process.env['_FACTORY_TEST_ANTHROPIC'];
    await expect(
      createEgoLlmAdapter({
        ...openaiCfg,
        fallback: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          apiKey: '${_FACTORY_TEST_ANTHROPIC}',
        },
      }),
    ).rejects.toThrow(/_FACTORY_TEST_ANTHROPIC/);
  });

  it('accepts literal (non-placeholder) apiKeys without env lookup', async () => {
    const adapter = await createEgoLlmAdapter({ ...openaiCfg, apiKey: 'sk-literal' });
    expect(adapter).toBeInstanceOf(OpenAiEgoLlmAdapter);
  });
});
