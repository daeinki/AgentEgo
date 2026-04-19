/**
 * Split a block of text into chunks of ~`targetTokens` each. The token count
 * is approximated the same way core's `estimateTokenCount` does (words + CJK
 * chars / 2) — good enough for bucketing.
 *
 * Chunks never split in the middle of a line; we accumulate whole lines until
 * the running token count would exceed the target, then emit.
 */
export interface ChunkerOptions {
  targetTokens: number;
}

const DEFAULT_TARGET_TOKENS = 300;

export function chunkText(
  text: string,
  options: Partial<ChunkerOptions> = {},
): string[] {
  const target = options.targetTokens ?? DEFAULT_TARGET_TOKENS;
  const lines = text.split(/\r?\n/);
  const chunks: string[] = [];
  let buffer: string[] = [];
  let running = 0;

  for (const line of lines) {
    const lineTokens = estimate(line);
    if (buffer.length > 0 && running + lineTokens > target) {
      chunks.push(buffer.join('\n').trim());
      buffer = [];
      running = 0;
    }
    buffer.push(line);
    running += lineTokens;
  }
  if (buffer.length > 0) {
    const last = buffer.join('\n').trim();
    if (last) chunks.push(last);
  }
  return chunks.filter((c) => c.length > 0);
}

export function estimateTokenCount(text: string): number {
  return estimate(text);
}

function estimate(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g) ?? []).length;
  return words + Math.ceil(cjk / 2);
}
