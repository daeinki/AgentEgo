import type { Contracts, ReasoningMode, StandardMessage } from '@agent-platform/core';

/**
 * Complexity-based mode router — agent-orchestration.md §2.
 *
 * Decision tree:
 *   1. forceMode override (debugging)
 *   2. empty tools → 'react' (plan_execute pointless without tools)
 *   3. EGO perception (workflow_execution / estimatedComplexity)
 *   4. heuristic score (sentences, imperatives, tools)
 */
export class DefaultComplexityRouter implements Contracts.ComplexityRouter {
  constructor(
    private readonly config: {
      sentenceThreshold?: number;
      imperativeThreshold?: number;
      toolThreshold?: number;
    } = {},
  ) {}

  select(input: Contracts.ComplexityRouterInput): ReasoningMode {
    if (input.forceMode) return input.forceMode;

    if (input.availableTools.length === 0) return 'react';

    const p = input.egoPerception;
    if (p) {
      if (p.requestType === 'workflow_execution') return 'plan_execute';
      if (p.estimatedComplexity === 'low') return 'react';
      if (p.estimatedComplexity === 'medium' || p.estimatedComplexity === 'high') {
        return 'plan_execute';
      }
    }

    const text = extractText(input.userMessage);
    const sentenceThreshold = this.config.sentenceThreshold ?? 2;
    const imperativeThreshold = this.config.imperativeThreshold ?? 2;
    const toolThreshold = this.config.toolThreshold ?? 3;

    let score = 0;
    if (countSentences(text) >= sentenceThreshold) score++;
    if (countImperativeVerbs(text) >= imperativeThreshold) score++;
    if (input.availableTools.length >= toolThreshold) score++;

    return score >= 2 ? 'plan_execute' : 'react';
  }
}

// ─── Heuristic helpers ─────────────────────────────────────────────────────

const SENTENCE_SPLIT = /[.!?。？！]/;

export function countSentences(text: string): number {
  const parts = text.split(SENTENCE_SPLIT).map((s) => s.trim()).filter(Boolean);
  return Math.max(1, parts.length);
}

// Korean patterns don't use \b — Korean characters aren't word characters in
// regex, so \b would force the match to end at a non-Hangul boundary.
const IMPERATIVE_PATTERNS = [
  /해줘/g,
  /만들어/g,
  /작성해/g,
  /분석해/g,
  /저장해/g,
  /생성해/g,
  /수정해/g,
  /삭제해/g,
  /확인해/g,
  /찾아줘/g,
  /알려줘/g,
  /실행해/g,
  /요약해/g,
  /\b(?:create|make|build|write|analyze|save|generate|modify|delete|find|fetch|run|execute|list|summarize)\b/gi,
];

export function countImperativeVerbs(text: string): number {
  let n = 0;
  for (const re of IMPERATIVE_PATTERNS) {
    re.lastIndex = 0;
    const m = text.match(re);
    if (m) n += m.length;
  }
  return n;
}

function extractText(msg: StandardMessage): string {
  const c = msg.content;
  if (c.type === 'text') return c.text;
  if (c.type === 'command') return `/${c.name} ${c.args.join(' ')}`;
  if (c.type === 'media') return c.caption ?? '';
  if (c.type === 'reaction') return c.emoji;
  return '';
}
