import OpenAI from 'openai';
import type { Contracts, EgoLlmConfig, EgoThinkingResult } from '@agent-platform/core';
import { resolveEnvVars } from '@agent-platform/core';
import { buildUserPrompt, parseOrThrow } from './llm-adapter-shared.js';

type EgoLlmAdapter = Contracts.EgoLlmAdapter;
type EgoThinkingRequest = Contracts.EgoThinkingRequest;

const PRICING: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'gpt-4.1': { inputPerMillion: 2, outputPerMillion: 8 },
  'gpt-4.1-mini': { inputPerMillion: 0.4, outputPerMillion: 1.6 },
};

/**
 * OpenAI-backed EGO LLM adapter. Uses native `response_format: json_object`
 * mode so EGO's strict JSON contract is enforced by the provider itself —
 * this eliminates the whole class of "model wrapped the JSON in prose" bugs
 * that the Anthropic adapter has to guard against via prompt engineering.
 */
export class OpenAiEgoLlmAdapter implements EgoLlmAdapter {
  private client!: OpenAI;
  private model!: string;
  private maxTokens = 1024;
  private temperature = 0.1;
  private topP?: number;
  private readonly providerLabel = 'openai';

  async initialize(config: EgoLlmConfig): Promise<void> {
    this.client = new OpenAI({
      apiKey: resolveEnvVars(config.apiKey),
      ...(config.baseURL ? { baseURL: resolveEnvVars(config.baseURL) } : {}),
    });
    this.model = config.model;
    this.maxTokens = config.maxTokens;
    this.temperature = config.temperature;
    if (config.topP !== undefined) this.topP = config.topP;
  }

  getModelInfo(): { provider: string; model: string; isFallback: boolean } {
    return { provider: this.providerLabel, model: this.model, isFallback: false };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const usesCompletionTokens = isNewGenModel(this.model);
      await this.client.chat.completions.create({
        model: this.model,
        ...(usesCompletionTokens
          ? { max_completion_tokens: 8 }
          : { max_tokens: 8 }),
        messages: [{ role: 'user', content: 'ping' }],
      });
      return true;
    } catch {
      return false;
    }
  }

  async think(req: EgoThinkingRequest): Promise<EgoThinkingResult> {
    // gpt-5.x and o1/o3/o4 reasoning models require `max_completion_tokens`
    // instead of `max_tokens` and reject custom temperature / top_p.
    const usesCompletionTokens = isNewGenModel(this.model);
    const supportsTemperature = !isReasoningModel(this.model);
    const supportsTopP = !isReasoningModel(this.model);
    const res = await this.client.chat.completions.create({
      model: this.model,
      ...(usesCompletionTokens
        ? { max_completion_tokens: this.maxTokens }
        : { max_tokens: this.maxTokens }),
      ...(supportsTemperature ? { temperature: this.temperature } : {}),
      ...(supportsTopP && this.topP !== undefined ? { top_p: this.topP } : {}),
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: req.systemPrompt },
        { role: 'user', content: buildUserPrompt(req) },
      ],
    });
    const text = res.choices[0]?.message.content ?? null;
    return parseOrThrow(text);
  }
}

/**
 * gpt-5.x and o1/o3/o4 reasoning models use `max_completion_tokens` instead
 * of the legacy `max_tokens` parameter. Keep this regex in sync with the
 * same check in agent-worker's model/openai.ts.
 */
function isNewGenModel(model: string): boolean {
  return /^(gpt-5|o1|o3|o4)/i.test(model);
}

/**
 * Reasoning models (o1/o3/o4/gpt-5) reject custom temperature and top_p —
 * only the provider default (1) is allowed.
 */
function isReasoningModel(model: string): boolean {
  return /^(o1|o3|o4|gpt-5)/i.test(model);
}

/**
 * Estimate the USD cost of a single OpenAI EGO call given token usage.
 * Unknown model → 0 (caller should not rely on cost-based guardrails for
 * unpriced models).
 */
export function estimateOpenAiCost(
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
