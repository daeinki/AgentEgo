import type { ComplexityLevel } from '../types/ego.js';

export interface ComplexityInput {
  tokenCount: number;
  clauseCount: number;
  sequentialConnectors: number;
}

/**
 * Classify a message's complexity per ego-design.md §4 Normalize rule table.
 *
 * - trivial: ≤10 tokens, 1 clause
 * - simple: ≤30 tokens, 1-2 clauses
 * - moderate: ≤80 tokens, 2-4 clauses
 * - complex: ≤200 tokens, many clauses
 * - multi_step: >200 tokens OR 3+ sequential connectors
 */
export function classifyComplexity(input: ComplexityInput): ComplexityLevel {
  const { tokenCount, clauseCount, sequentialConnectors } = input;
  if (tokenCount > 200 || sequentialConnectors >= 3) return 'multi_step';
  if (tokenCount <= 10 && clauseCount <= 1) return 'trivial';
  if (tokenCount <= 30 && clauseCount <= 2) return 'simple';
  if (tokenCount <= 80 && clauseCount <= 4) return 'moderate';
  return 'complex';
}

const SEQUENTIAL_CONNECTOR_PATTERNS = [
  /\b(?:then|next|after that|finally)\b/gi,
  /(?:^|[\s,.])(?:먼저|그리고|그\s*후|그\s*다음|다음으로)(?=[\s,.!?]|$)/g,
];

/**
 * Rough connector counter for Korean + English. Not language-perfect;
 * meant as a deterministic signal for complexity classification.
 */
export function countSequentialConnectors(text: string): number {
  let n = 0;
  for (const re of SEQUENTIAL_CONNECTOR_PATTERNS) {
    re.lastIndex = 0;
    const matches = text.match(re);
    if (matches) n += matches.length;
  }
  return n;
}

const CLAUSE_SPLIT = /[,.!?;]|그리고|하지만|그런데|그러나/g;

export function countClauses(text: string): number {
  const parts = text.split(CLAUSE_SPLIT).map((s) => s.trim()).filter(Boolean);
  return Math.max(1, parts.length);
}

export function estimateTokenCount(text: string): number {
  // Rough approximation: words + CJK chars / 2. Good enough for bucket classification.
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g) ?? []).length;
  return words + Math.ceil(cjk / 2);
}

export function classifyText(text: string): ComplexityLevel {
  return classifyComplexity({
    tokenCount: estimateTokenCount(text),
    clauseCount: countClauses(text),
    sequentialConnectors: countSequentialConnectors(text),
  });
}
