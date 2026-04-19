import type {
  ComplexityLevel,
  EgoFullConfig,
  IntentType,
  UrgencyLevel,
} from '@agent-platform/core';
import { classifyText } from '@agent-platform/core';
import type { EgoSignal } from './signal.js';

export interface ExtractedEntity {
  type: 'keyword' | 'reference' | 'filepath' | 'date' | 'mention' | 'number';
  value: string;
}

export interface NormalizedSignal extends EgoSignal {
  intent: { primary: IntentType; confidence: number };
  urgency: UrgencyLevel;
  entities: ExtractedEntity[];
  sentiment: { valence: number; arousal: number };
  complexity: ComplexityLevel;
}

const URGENCY_KEYWORDS: Record<Exclude<UrgencyLevel, 'normal'>, RegExp> = {
  critical: /(?:긴급|지금\s*당장|바로|즉시)|\b(?:emergency|critical|asap)\b/i,
  high: /(?:빨리|중요|곧|서둘러)|\b(?:urgent|important)\b|!{2,}/i,
  low: /(?:나중에|언젠가|천천히)|\b(?:later|eventually)\b/i,
};

export function classifyUrgency(text: string): UrgencyLevel {
  for (const level of ['critical', 'high', 'low'] as const) {
    if (URGENCY_KEYWORDS[level].test(text)) return level;
  }
  return 'normal';
}

export function classifyIntent(signal: EgoSignal): { primary: IntentType; confidence: number } {
  if (signal.contentType === 'command') return { primary: 'command', confidence: 1.0 };
  if (signal.contentType === 'reaction') return { primary: 'feedback', confidence: 0.8 };

  const text = signal.rawText.trim();
  if (!text) return { primary: 'ambiguous', confidence: 0.2 };

  if (/^(?:안녕|ㅎㅇ|반가워)|^(?:hi|hello|hey)\b/i.test(text)) {
    return { primary: 'greeting', confidence: 0.9 };
  }
  if (/[?？]$/.test(text) || /^(?:뭐|어떻게|왜|언제|어디|누가)|^(?:what|how|why|when|where|who)\b/i.test(text)) {
    return { primary: 'question', confidence: 0.75 };
  }
  if (/(?:틀렸|아니야|잘못|수정|다시)|\b(?:wrong|incorrect|fix that)\b/i.test(text)) {
    return { primary: 'correction', confidence: 0.7 };
  }
  if (/(?:잘했|좋아|최고|고마워|감사)|\b(?:good job|thanks)\b/i.test(text)) {
    return { primary: 'feedback', confidence: 0.7 };
  }
  if (
    /(?:해줘|만들어|해라|하세요|보여줘|찾아줘|찾아봐|해라|줘)\s*$/i.test(text) ||
    /^(?:please|do|make|create)\b/i.test(text)
  ) {
    return { primary: 'instruction', confidence: 0.75 };
  }
  if (/(?:너|당신|에이전트|너의)/i.test(text) && /(?:이름|뭐야|누구)/i.test(text)) {
    return { primary: 'meta', confidence: 0.6 };
  }
  return { primary: 'conversation', confidence: 0.4 };
}

const ENTITY_RULES: { type: ExtractedEntity['type']; regex: RegExp }[] = [
  { type: 'mention', regex: /@[\w-]+/g },
  { type: 'filepath', regex: /(?:[a-zA-Z]:)?(?:[\/\\][\w.-]+)+\.[a-z]{1,5}/g },
  { type: 'date', regex: /\b\d{4}-\d{2}-\d{2}\b/g },
  { type: 'number', regex: /\b\d+(?:\.\d+)?\b/g },
];

export function extractEntities(text: string): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  for (const { type, regex } of ENTITY_RULES) {
    const matches = text.match(regex);
    if (matches) {
      for (const value of matches) entities.push({ type, value });
    }
  }
  return entities;
}

export function classifySentiment(text: string): { valence: number; arousal: number } {
  const pos = /(?:좋|감사|고마|최고|great|awesome|love|perfect|nice)/gi;
  const neg = /(?:싫|짜증|화|틀렸|fail|wrong|bad|terrible|hate)/gi;
  const excited = /(?:!|꼭|반드시|urgent|긴급)/g;
  const posN = (text.match(pos) ?? []).length;
  const negN = (text.match(neg) ?? []).length;
  const excN = (text.match(excited) ?? []).length;
  const valence = (posN - negN) / Math.max(1, posN + negN);
  const arousal = Math.min(1, (posN + negN + excN) / 5);
  return { valence, arousal };
}

export function normalize(signal: EgoSignal): NormalizedSignal {
  return {
    ...signal,
    intent: classifyIntent(signal),
    urgency: classifyUrgency(signal.rawText),
    entities: extractEntities(signal.rawText),
    sentiment: classifySentiment(signal.rawText),
    complexity: classifyText(signal.rawText),
  };
}

const LEVEL_ORDER: readonly ComplexityLevel[] = [
  'trivial',
  'simple',
  'moderate',
  'complex',
  'multi_step',
];

export function shouldFastExit(signal: NormalizedSignal, config: EgoFullConfig): boolean {
  if (config.fastPath.passthroughIntents.includes(signal.intent.primary)) return true;
  for (const pattern of config.fastPath.passthroughPatterns) {
    if (new RegExp(pattern, 'i').test(signal.rawText)) return true;
  }
  const signalIdx = LEVEL_ORDER.indexOf(signal.complexity);
  const thresholdIdx = LEVEL_ORDER.indexOf(config.fastPath.maxComplexityForPassthrough);
  return signalIdx <= thresholdIdx;
}
