import type { Wing } from '../palace/layout.js';

export interface ClassificationMatch {
  wing: Wing;
  confidence: number;
  subcategory?: string;
}

interface Rule {
  wing: Wing;
  subcategory?: string;
  patterns: RegExp[];
  weight: number;
}

const RULES: Rule[] = [
  {
    wing: 'personal',
    subcategory: 'preferences',
    patterns: [
      /(?:내가\s*좋아|내가\s*싫어|선호해|좋아하는|싫어하는)/i,
      /\b(?:i\s*(?:like|prefer|love|hate)|my\s+favorite)\b/i,
    ],
    weight: 1,
  },
  {
    wing: 'personal',
    subcategory: 'contacts',
    patterns: [/@\w+/, /\b(?:contact|phone|email)\b/i],
    weight: 0.5,
  },
  {
    wing: 'work',
    subcategory: 'projects',
    patterns: [
      /(?:프로젝트|배포|PR|pull\s*request|commit|브랜치|branch)/i,
      /\b(?:deploy|release|ticket|sprint|milestone)\b/i,
    ],
    weight: 1,
  },
  {
    wing: 'work',
    subcategory: 'meetings',
    patterns: [/(?:회의|미팅|meeting|sync|standup)/i],
    weight: 0.7,
  },
  {
    wing: 'knowledge',
    subcategory: 'technical',
    patterns: [
      /(?:TypeScript|Python|SQL|docker|kubernetes|sqlite|postgres|regex)/i,
      /(?:API|함수|function|class|interface)/i,
    ],
    weight: 0.9,
  },
  {
    wing: 'interactions',
    subcategory: 'corrections',
    patterns: [/(?:틀렸|아니야|수정|다시)/i, /\b(?:wrong|incorrect|fix that)\b/i],
    weight: 1,
  },
  {
    wing: 'interactions',
    subcategory: 'feedback',
    patterns: [/(?:잘했|좋아|최고|고마워|감사)/i, /\b(?:good job|thanks|appreciate)\b/i],
    weight: 0.8,
  },
];

/**
 * Rule-based wing classifier. Each rule contributes `weight` when any of its
 * patterns match; the highest-scoring wing wins. Ties go to `knowledge` (the
 * safest default for information we aren't sure about).
 */
export function classifyContent(content: string): ClassificationMatch {
  const scores = new Map<string, { score: number; subcategory?: string; wing: Wing }>();
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(content))) {
      const key = `${rule.wing}/${rule.subcategory ?? '_'}`;
      const existing = scores.get(key);
      if (existing) existing.score += rule.weight;
      else {
        const entry: { score: number; subcategory?: string; wing: Wing } = {
          score: rule.weight,
          wing: rule.wing,
        };
        if (rule.subcategory !== undefined) entry.subcategory = rule.subcategory;
        scores.set(key, entry);
      }
    }
  }

  if (scores.size === 0) {
    return { wing: 'knowledge', confidence: 0.2 };
  }

  const [topKey, top] = [...scores.entries()].sort((a, b) => b[1].score - a[1].score)[0]!;
  const total = [...scores.values()].reduce((acc, v) => acc + v.score, 0);
  void topKey;
  const match: ClassificationMatch = {
    wing: top.wing,
    confidence: Math.min(1, top.score / Math.max(1, total)),
  };
  if (top.subcategory !== undefined) match.subcategory = top.subcategory;
  return match;
}
