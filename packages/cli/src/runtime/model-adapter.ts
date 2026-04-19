import {
  AnthropicAdapter,
  OpenAIAdapter,
  type ModelAdapter,
} from '@agent-platform/agent-worker';

/**
 * Resolve and construct the LLM adapter based on environment:
 *
 * - `AGENT_PROVIDER` (explicit override, 'anthropic' | 'openai')
 * - Otherwise inferred from `AGENT_MODEL` prefix ('claude...' → anthropic)
 * - Otherwise whichever API key is set (OpenAI preferred)
 *
 * Shared by `agent send` (one-shot) and `agent gateway start` (daemon).
 */
export function createModelAdapter(): ModelAdapter {
  const explicit = process.env['AGENT_PROVIDER']?.toLowerCase();
  const modelName = process.env['AGENT_MODEL'];
  const provider =
    explicit ??
    (modelName?.startsWith('claude') ? 'anthropic' : undefined) ??
    (process.env['OPENAI_API_KEY'] ? 'openai' : undefined) ??
    (process.env['ANTHROPIC_API_KEY'] ? 'anthropic' : undefined) ??
    'openai';

  if (provider === 'anthropic') {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      console.error('Error: ANTHROPIC_API_KEY is required when AGENT_PROVIDER=anthropic.');
      console.error('Add it to .env or set $env:ANTHROPIC_API_KEY = "your-key"');
      process.exit(1);
    }
    return new AnthropicAdapter({
      apiKey,
      model: modelName ?? 'claude-sonnet-4-20250514',
    });
  }

  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    console.error('Error: OPENAI_API_KEY is required (default provider is openai).');
    console.error('Add it to .env or set $env:OPENAI_API_KEY = "your-key"');
    process.exit(1);
  }
  return new OpenAIAdapter({
    apiKey,
    model: modelName ?? 'gpt-4o-mini',
    ...(process.env['OPENAI_BASE_URL'] ? { baseURL: process.env['OPENAI_BASE_URL'] } : {}),
  });
}
