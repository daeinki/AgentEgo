import type { Contracts, EgoLlmConfig, EgoThinkingResult } from '@agent-platform/core';

type EgoLlmAdapter = Contracts.EgoLlmAdapter;
type EgoThinkingRequest = Contracts.EgoThinkingRequest;

/**
 * Decorator that layers a secondary EGO LLM adapter on top of a primary
 * adapter. On `think()` failure the fallback is invoked automatically and
 * `getModelInfo().isFallback` flips to true for subsequent reads until the
 * next successful primary call. Works for any provider combination — the
 * primary and fallback adapters do not need to share a provider.
 *
 * Both adapters must already be initialized before being wrapped. The
 * `initialize()` method on this decorator is a no-op and is provided only
 * to satisfy the `Contracts.EgoLlmAdapter` interface.
 */
export class FallbackEgoLlmAdapter implements EgoLlmAdapter {
  private activeIsFallback = false;

  constructor(
    private readonly primary: EgoLlmAdapter,
    private readonly fallback: EgoLlmAdapter,
  ) {}

  async initialize(_config: EgoLlmConfig): Promise<void> {
    // Intentional no-op: constructor takes pre-initialized adapters. This
    // method exists only so the decorator satisfies EgoLlmAdapter.
  }

  async think(req: EgoThinkingRequest): Promise<EgoThinkingResult> {
    try {
      const r = await this.primary.think(req);
      this.activeIsFallback = false;
      return r;
    } catch {
      this.activeIsFallback = true;
      return await this.fallback.think(req);
    }
  }

  async healthCheck(): Promise<boolean> {
    if (await this.primary.healthCheck()) return true;
    return this.fallback.healthCheck();
  }

  getModelInfo(): { provider: string; model: string; isFallback: boolean } {
    const base = this.activeIsFallback
      ? this.fallback.getModelInfo()
      : this.primary.getModelInfo();
    return { provider: base.provider, model: base.model, isFallback: this.activeIsFallback };
  }
}
