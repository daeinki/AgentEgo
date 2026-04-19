import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface WingAppendParams {
  filePath: string;
  heading?: string;
  content: string;
  timestampIso: string;
}

/**
 * Append a new chunk to a wing's markdown file. Uses a simple block format so
 * the file remains human-readable and round-trippable.
 *
 * ```md
 * ## 2026-04-17T12:34:56Z — heading
 * content body
 *
 * ```
 */
export async function appendWingEntry(params: WingAppendParams): Promise<void> {
  await mkdir(dirname(params.filePath), { recursive: true });
  const heading = params.heading ? ` — ${params.heading}` : '';
  const block =
    `\n## ${params.timestampIso}${heading}\n\n${params.content.trimEnd()}\n`;
  await appendFile(params.filePath, block, 'utf-8');
}

/**
 * Given a 1-based line number in a wing file and a chunk length, return the
 * `lineRange` tuple used by MemorySearchResult.
 */
export function lineRangeFor(startLine: number, content: string): [number, number] {
  const lines = content.split('\n').length;
  return [startLine, startLine + lines - 1];
}
