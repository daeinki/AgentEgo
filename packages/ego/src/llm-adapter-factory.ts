import type { Contracts, EgoLlmConfig } from '@agent-platform/core';
import { AnthropicEgoLlmAdapter } from './llm-adapter.js';
import { OpenAiEgoLlmAdapter } from './llm-adapter-openai.js';
import { FallbackEgoLlmAdapter } from './llm-adapter-fallback.js';

export type EgoLlmProvider = 'anthropic' | 'openai';

const SUPPORTED_PROVIDERS: ReadonlySet<EgoLlmProvider> = new Set(['anthropic', 'openai']);

/**
 * Build a `Contracts.EgoLlmAdapter` from an `EgoLlmConfig`. Picks the
 * provider-specific adapter, runs env-var preflight on every referenced
 * apiKey (primary + fallback), initializes both, and composes them under
 * `FallbackEgoLlmAdapter` when a fallback block is present.
 *
 * Throws on:
 *  - unknown provider
 *  - `${VAR}` placeholders whose env var is unset
 *  - provider-SDK construction failures surfaced from initialize()
 *
 * Callers (e.g. gateway start) should treat a throw as a startup blocker
 * and surface a diagnostic message to the user.
 */
export async function createEgoLlmAdapter(
  config: EgoLlmConfig,
): Promise<Contracts.EgoLlmAdapter> {
  assertProviderSupported(config.provider);
  assertApiKeyAvailable(config.provider, config.apiKey);
  if (config.fallback) {
    assertProviderSupported(config.fallback.provider);
    assertApiKeyAvailable(config.fallback.provider, config.fallback.apiKey);
  }

  const primary = await instantiate(config.provider, config);
  if (!config.fallback) return primary;

  const fallbackCfg: EgoLlmConfig = {
    provider: config.fallback.provider,
    model: config.fallback.model,
    apiKey: config.fallback.apiKey,
    ...(config.fallback.baseURL ? { baseURL: config.fallback.baseURL } : {}),
    temperature: config.fallback.temperature ?? 0.1,
    maxTokens: config.fallback.maxTokens ?? 1024,
  };
  const fallback = await instantiate(config.fallback.provider, fallbackCfg);
  return new FallbackEgoLlmAdapter(primary, fallback);
}

async function instantiate(
  provider: EgoLlmProvider,
  cfg: EgoLlmConfig,
): Promise<Contracts.EgoLlmAdapter> {
  switch (provider) {
    case 'anthropic': {
      const a = new AnthropicEgoLlmAdapter();
      await a.initialize(cfg);
      return a;
    }
    case 'openai': {
      const a = new OpenAiEgoLlmAdapter();
      await a.initialize(cfg);
      return a;
    }
  }
}

function assertProviderSupported(provider: string): void {
  if (!SUPPORTED_PROVIDERS.has(provider as EgoLlmProvider)) {
    const supported = [...SUPPORTED_PROVIDERS].join(' | ');
    throw new Error(
      `Unsupported ego.llm.provider: '${provider}' (supported: ${supported})`,
    );
  }
}

function assertApiKeyAvailable(provider: string, apiKey: string): void {
  const m = /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(apiKey);
  if (m && !process.env[m[1]!]) {
    throw new Error(
      `ego.llm for provider '${provider}' references \${${m[1]}} but the env var is unset`,
    );
  }
}
