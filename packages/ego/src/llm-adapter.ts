import Anthropic from '@anthropic-ai/sdk';
import type { Contracts, EgoLlmConfig, EgoThinkingResult } from '@agent-platform/core';
import { resolveEnvVars } from '@agent-platform/core';
import { buildUserPrompt, parseOrThrow } from './llm-adapter-shared.js';

type EgoLlmAdapter = Contracts.EgoLlmAdapter;
type EgoThinkingRequest = Contracts.EgoThinkingRequest;

const PRICING: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  'claude-haiku-4-5-20251001': { inputPerMillion: 0.8, outputPerMillion: 4 },
  'claude-sonnet-4-6': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-opus-4-6': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-opus-4-7': { inputPerMillion: 5, outputPerMillion: 25 },
};

/**
 * Anthropic-backed EGO LLM adapter. Single-provider — fallback composition
 * is the responsibility of `FallbackEgoLlmAdapter`, so this class stays
 * focused on one API surface.
 */
export class AnthropicEgoLlmAdapter implements EgoLlmAdapter {
  private client!: Anthropic;
  private model!: string;
  private maxTokens = 1024;
  private readonly providerLabel = 'anthropic';

  async initialize(config: EgoLlmConfig): Promise<void> {
    this.client = new Anthropic({
      apiKey: resolveEnvVars(config.apiKey),
      ...(config.baseURL ? { baseURL: resolveEnvVars(config.baseURL) } : {}),
    });
    this.model = config.model;
    this.maxTokens = config.maxTokens;
    // Opus 4.7 rejects `temperature` / `top_p` / `top_k`; config fields for
    // those are honored by the OpenAI adapter only.
  }

  getModelInfo(): { provider: string; model: string; isFallback: boolean } {
    return { provider: this.providerLabel, model: this.model, isFallback: false };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.messages.create({
        model: this.model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return true;
    } catch {
      return false;
    }
  }

  async think(req: EgoThinkingRequest): Promise<EgoThinkingResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      // EGO is latency-sensitive classification, not agentic reasoning.
      output_config: { effort: 'low' },
      // Cache the (stable) system prompt; EGO reuses it every turn.
      system: [
        { type: 'text', text: req.systemPrompt, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        {
          role: 'user',
          content: buildUserPrompt(req),
        },
      ],
    });
    return parseOrThrow(extractTextBlock(response));
  }
}

function extractTextBlock(response: Anthropic.Message): string | null {
  for (const block of response.content) {
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return null;
}

/**
 * Estimate the USD cost of a single EGO LLM call given token usage. Unknown
 * model → 0.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = PRICING[model];
  if (!pricing) return 0;
  return (
    (inputTokens * pricing.inputPerMillion) / 1e6 +
    (outputTokens * pricing.outputPerMillion) / 1e6
  );
}
