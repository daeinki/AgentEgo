import type {
  EvolutionRules,
  Persona,
  PersonaFeedback,
} from '@agent-platform/core';
import { nowIso } from '@agent-platform/core';

export interface EvolutionOutcome {
  changed: boolean;
  fieldPath?: string;
  delta?: number;
  reason?: string;
  /**
   * If set, the caller should surface this to the user and pause further
   * auto-evolution on `fieldPath` until the user picks a target value.
   */
  needsConfirmation?: {
    field: string;
    recentChanges: Array<{ at: string; delta: number }>;
    suggestion: string;
  };
}

export const DEFAULT_EVOLUTION_RULES: EvolutionRules = {
  maxDeltaPerEvent: 0.1,
  inertiaFactor: 0.3,
  reinforcementThreshold: 3,
  decayDays: 30,
  decayRate: 0.05,
  confirmThreshold: 0.3,
  confirmWindowCount: 3,
};

interface FieldRef {
  path: string;           // dot path, e.g. 'communicationStyle.verbosity'
  setter: (persona: Persona, next: number) => void;
  getter: (persona: Persona) => number;
}

const STYLE_FIELDS: Record<string, FieldRef> = mkStyleFields();
const VALUE_FIELDS: Record<string, FieldRef> = mkValueFields();

function mkStyleFields(): Record<string, FieldRef> {
  const keys = [
    'formality',
    'verbosity',
    'humor',
    'empathy',
    'directness',
    'proactivity',
  ] as const;
  const out: Record<string, FieldRef> = {};
  for (const k of keys) {
    out[k] = {
      path: `communicationStyle.${k}`,
      getter: (p) => p.communicationStyle[k],
      setter: (p, v) => {
        p.communicationStyle[k] = clamp01(v);
      },
    };
  }
  return out;
}

function mkValueFields(): Record<string, FieldRef> {
  const keys = [
    'accuracy',
    'speed',
    'privacy',
    'creativity',
    'costEfficiency',
    'safety',
    'autonomy',
  ] as const;
  const out: Record<string, FieldRef> = {};
  for (const k of keys) {
    out[k] = {
      path: `valuePriorities.${k}`,
      getter: (p) => p.valuePriorities[k],
      setter: (p, v) => {
        p.valuePriorities[k] = clamp01(v);
      },
    };
  }
  return out;
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * §4.5 + §4.6: inspect the last N evolutionLog entries for the same field.
 * Returns the sum of recent signed deltas (positive or negative) and their
 * count, which lets the caller decide whether reinforcement applies or
 * whether we're flipping direction.
 */
function recentSignals(
  persona: Persona,
  fieldPath: string,
  windowCount: number,
): { totalDelta: number; entries: Array<{ at: string; delta: number }> } {
  const entries: Array<{ at: string; delta: number }> = [];
  for (let i = persona.evolutionLog.length - 1; i >= 0 && entries.length < windowCount; i -= 1) {
    const e = persona.evolutionLog[i]!;
    if (e.change.field === fieldPath && typeof e.change.delta === 'number') {
      entries.push({ at: e.timestamp, delta: e.change.delta });
    }
  }
  const totalDelta = entries.reduce((acc, x) => acc + x.delta, 0);
  return { totalDelta, entries };
}

/**
 * §4.7: coarse interaction-count → maturity transition. Returns the maturity
 * the persona should be at given its totalInteractions.
 */
export function computeMaturity(totalInteractions: number): Persona['relationshipContext']['communicationMaturity'] {
  if (totalInteractions < 30) return 'new';
  if (totalInteractions < 100) return 'developing';
  return 'established';
}

/**
 * Apply a cap multiplier to `delta` based on maturity. New relationships
 * evolve at half the rate to avoid premature drift.
 */
export function maturityScale(maturity: Persona['relationshipContext']['communicationMaturity']): number {
  switch (maturity) {
    case 'new':
      return 0.5;
    case 'developing':
      return 0.8;
    case 'established':
      return 1.0;
  }
}

export interface EvolveParams {
  persona: Persona;
  feedback: PersonaFeedback;
  rules?: Partial<EvolutionRules>;
}

/**
 * Pure evolution step: mutates the incoming persona (caller is responsible
 * for persistence) and returns an outcome describing what changed.
 *
 * Implements:
 * - §4.2 progressive delta cap (maxDeltaPerEvent)
 * - §4.2 reinforcement (1.5x cap after N same-direction events)
 * - §4.6 opposite-direction detection → needsConfirmation
 * - §4.7 maturity scale-down
 */
export function evolvePersona(params: EvolveParams): EvolutionOutcome {
  const rules: EvolutionRules = { ...DEFAULT_EVOLUTION_RULES, ...params.rules };
  const { persona, feedback } = params;

  // Every feedback counts as an interaction for maturity transitions.
  // §4.7 — upgrade-only path (new → developing → established).
  persona.totalInteractions += 1;
  const derived = computeMaturity(persona.totalInteractions);
  const current = persona.relationshipContext.communicationMaturity;
  const ORDER = { new: 0, developing: 1, established: 2 } as const;
  if (ORDER[derived] > ORDER[current]) {
    persona.relationshipContext.communicationMaturity = derived;
  }

  switch (feedback.type) {
    case 'explicit-instruction':
      return applyStyleHint(persona, feedback.instruction, feedback.appliesTo, rules, 'explicit');

    case 'positive-feedback':
      return reinforceFromFeedback(persona, feedback.behavior, rules, +1);

    case 'negative-feedback': {
      const scale = feedback.severity === 'strong' ? 1 : 0.5;
      return reinforceFromFeedback(persona, feedback.behavior, rules, -scale);
    }

    case 'correction':
      // Learn a new behavior pattern (no numeric field change).
      persona.learnedBehaviors.push({
        trigger: feedback.pattern,
        learned: `${feedback.original} → ${feedback.corrected}`,
        confidence: 0.6,
        source: 'correction',
        learnedAt: nowIso(),
      });
      persona.evolutionCount += 1;
      return { changed: true, reason: 'correction learned as behavior pattern' };

    case 'implicit':
      persona.learnedBehaviors.push({
        trigger: feedback.observation,
        learned: feedback.suggestedBehavior,
        confidence: 0.3,
        source: 'implicit',
        learnedAt: nowIso(),
      });
      persona.evolutionCount += 1;
      return { changed: true, reason: 'implicit pattern recorded' };

    case 'domain-exposure': {
      const idx = persona.domainExpertise.findIndex((e) => e.domain === feedback.domain);
      if (idx < 0) {
        persona.domainExpertise.push({
          domain: feedback.domain,
          confidence: 0.3,
          subTopics: [feedback.subtopic],
          learnedFrom: feedback.interactionCount,
          lastActive: nowIso(),
        });
      } else {
        const existing = persona.domainExpertise[idx]!;
        existing.confidence = clamp01(existing.confidence + 0.05);
        existing.learnedFrom += feedback.interactionCount;
        existing.lastActive = nowIso();
        if (!existing.subTopics.includes(feedback.subtopic)) {
          existing.subTopics.push(feedback.subtopic);
        }
      }
      persona.evolutionCount += 1;
      return { changed: true, reason: 'domain exposure recorded' };
    }
  }
}

function applyStyleHint(
  persona: Persona,
  instruction: string,
  appliesTo: string,
  rules: EvolutionRules,
  _source: 'explicit' | 'implicit',
): EvolutionOutcome {
  const field = STYLE_FIELDS[appliesTo] ?? VALUE_FIELDS[appliesTo];
  if (!field) {
    return { changed: false, reason: `unknown field: ${appliesTo}` };
  }

  const direction = inferDirection(instruction);
  if (direction === 0) {
    return { changed: false, reason: 'no direction inferred from instruction' };
  }

  return applyDelta(persona, field, direction * rules.maxDeltaPerEvent, rules, `explicit: ${instruction.slice(0, 40)}`);
}

function reinforceFromFeedback(
  persona: Persona,
  behavior: string,
  rules: EvolutionRules,
  sign: number,
): EvolutionOutcome {
  // Heuristic: positive feedback nudges proactivity up; negative nudges it
  // down. Without richer NLP, this is crude but stable.
  const field = STYLE_FIELDS['proactivity']!;
  const delta = sign * rules.maxDeltaPerEvent * 0.5;
  return applyDelta(persona, field, delta, rules, `feedback: ${behavior.slice(0, 40)}`);
}

function applyDelta(
  persona: Persona,
  field: FieldRef,
  rawDelta: number,
  rules: EvolutionRules,
  reason: string,
): EvolutionOutcome {
  // §4.6 — check for opposite-direction flip within the confirm window.
  const recent = recentSignals(persona, field.path, rules.confirmWindowCount);
  const wouldFlip =
    recent.entries.length >= 2 &&
    recent.entries.some((e) => Math.sign(e.delta) !== Math.sign(rawDelta)) &&
    Math.abs(recent.totalDelta) + Math.abs(rawDelta) >= rules.confirmThreshold;

  if (wouldFlip) {
    return {
      changed: false,
      fieldPath: field.path,
      needsConfirmation: {
        field: field.path,
        recentChanges: recent.entries,
        suggestion:
          `Field ${field.path} has flipped direction recently. Ask the user to pick a target value.`,
      },
      reason: 'awaiting user disambiguation (§4.6)',
    };
  }

  // §4.2 — reinforcement: if last N events in the same direction, enlarge cap.
  let effectiveCap = rules.maxDeltaPerEvent;
  if (
    recent.entries.length >= rules.reinforcementThreshold &&
    recent.entries.every((e) => Math.sign(e.delta) === Math.sign(rawDelta))
  ) {
    effectiveCap *= 1.5;
  }

  // §4.7 — maturity scale-down.
  const scale = maturityScale(persona.relationshipContext.communicationMaturity);
  const capped = Math.sign(rawDelta) * Math.min(Math.abs(rawDelta), effectiveCap);
  const scaled = capped * scale;

  const before = field.getter(persona);
  field.setter(persona, before + scaled);
  const after = field.getter(persona);
  const realDelta = after - before;

  if (realDelta === 0) {
    return { changed: false, fieldPath: field.path, reason: 'field saturated at bound' };
  }

  persona.evolutionCount += 1;
  persona.updatedAt = nowIso();
  persona.evolutionLog.push({
    timestamp: nowIso(),
    trigger: reason,
    change: {
      field: field.path,
      from: before,
      to: after,
      delta: realDelta,
    },
    reason,
  });

  return {
    changed: true,
    fieldPath: field.path,
    delta: realDelta,
    reason,
  };
}

/**
 * Very rough direction inference from a natural-language instruction.
 * Returns -1 (decrease), +1 (increase), or 0 (no clue).
 */
export function inferDirection(instruction: string): -1 | 0 | 1 {
  const lower = instruction.toLowerCase();
  const down = /(?:간결|짧게|줄여|less|shorter|concise|더\s*적게)/;
  const up = /(?:상세|길게|더\s*많이|more|longer|detailed|설명\s*(?:더|추가))/;
  if (down.test(lower) && !up.test(lower)) return -1;
  if (up.test(lower) && !down.test(lower)) return +1;
  return 0;
}

/**
 * §4.2 decay — downweights learnedBehaviors that haven't been referenced in
 * a while. Callers invoke this periodically (e.g. once per day).
 */
export function applyDecay(persona: Persona, rules: Partial<EvolutionRules> = {}): number {
  const merged = { ...DEFAULT_EVOLUTION_RULES, ...rules };
  const cutoff = Date.now() - merged.decayDays * 86_400_000;
  let affected = 0;
  for (const b of persona.learnedBehaviors) {
    const learnedMs = new Date(b.learnedAt).getTime();
    if (learnedMs < cutoff) {
      const before = b.confidence;
      b.confidence = clamp01(b.confidence - merged.decayRate);
      if (b.confidence !== before) affected += 1;
    }
  }
  return affected;
}
