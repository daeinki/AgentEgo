import { describe, it, expect } from 'vitest';
import type { Persona } from '@agent-platform/core';
import {
  evolvePersona,
  applyDecay,
  computeMaturity,
  maturityScale,
  inferDirection,
  DEFAULT_EVOLUTION_RULES,
} from './persona-evolution.js';

function freshPersona(overrides: Partial<Persona> = {}): Persona {
  const now = new Date().toISOString();
  return {
    version: '1.0.0',
    personaId: 'prs-test',
    createdAt: now,
    updatedAt: now,
    totalInteractions: 0,
    evolutionCount: 0,
    identity: { name: 'M', role: 'asst', coreDirective: 'help' },
    communicationStyle: {
      formality: 0.5,
      verbosity: 0.5,
      humor: 0.5,
      empathy: 0.5,
      directness: 0.5,
      proactivity: 0.5,
      preferredLanguage: 'ko',
      adaptToUser: true,
    },
    emotionalTendencies: {
      defaultMood: 'calm',
      sensitivityToFrustration: 0.5,
      celebrationLevel: 0.5,
      cautiousness: 0.5,
      curiosity: 0.5,
      patience: 0.5,
    },
    valuePriorities: {
      accuracy: 0.5,
      speed: 0.5,
      privacy: 0.5,
      creativity: 0.5,
      costEfficiency: 0.5,
      safety: 0.5,
      autonomy: 0.5,
    },
    domainExpertise: [],
    learnedBehaviors: [],
    relationshipContext: {
      interactionStartDate: now,
      trustLevel: 0.5,
      communicationMaturity: 'established', // default to established to skip §4.7 scale-down in most tests
      knownPreferences: [],
      knownDislikes: [],
      insideJokes: [],
      milestones: [],
    },
    evolutionLog: [],
    ...overrides,
  };
}

describe('inferDirection', () => {
  it('detects downward instructions', () => {
    expect(inferDirection('더 간결하게')).toBe(-1);
    expect(inferDirection('make it concise')).toBe(-1);
  });
  it('detects upward instructions', () => {
    expect(inferDirection('더 상세히 설명')).toBe(1);
    expect(inferDirection('please be more detailed')).toBe(1);
  });
  it('returns 0 when ambiguous', () => {
    expect(inferDirection('배포해줘')).toBe(0);
  });
});

describe('computeMaturity & maturityScale (§4.7)', () => {
  it('new < 30 interactions', () => {
    expect(computeMaturity(0)).toBe('new');
    expect(computeMaturity(29)).toBe('new');
  });
  it('developing between 30 and 99', () => {
    expect(computeMaturity(30)).toBe('developing');
    expect(computeMaturity(99)).toBe('developing');
  });
  it('established at 100+', () => {
    expect(computeMaturity(100)).toBe('established');
    expect(computeMaturity(1000)).toBe('established');
  });

  it('maturityScale increases with maturity', () => {
    expect(maturityScale('new')).toBe(0.5);
    expect(maturityScale('developing')).toBe(0.8);
    expect(maturityScale('established')).toBe(1.0);
  });
});

describe('evolvePersona — explicit-instruction', () => {
  it('nudges verbosity down when asked to be concise', () => {
    const p = freshPersona();
    const before = p.communicationStyle.verbosity;
    const outcome = evolvePersona({
      persona: p,
      feedback: { type: 'explicit-instruction', instruction: '더 간결하게', appliesTo: 'verbosity' },
    });
    expect(outcome.changed).toBe(true);
    expect(p.communicationStyle.verbosity).toBeLessThan(before);
    expect(p.evolutionLog).toHaveLength(1);
    expect(p.evolutionLog[0]?.change.field).toBe('communicationStyle.verbosity');
  });

  it('nudges up when asked to be more detailed', () => {
    const p = freshPersona();
    const before = p.communicationStyle.verbosity;
    evolvePersona({
      persona: p,
      feedback: { type: 'explicit-instruction', instruction: '더 상세히 설명', appliesTo: 'verbosity' },
    });
    expect(p.communicationStyle.verbosity).toBeGreaterThan(before);
  });

  it('no-op when field is unknown', () => {
    const p = freshPersona();
    const outcome = evolvePersona({
      persona: p,
      feedback: { type: 'explicit-instruction', instruction: 'x', appliesTo: 'unknownField' },
    });
    expect(outcome.changed).toBe(false);
  });

  it('no-op when direction is ambiguous', () => {
    const p = freshPersona();
    const outcome = evolvePersona({
      persona: p,
      feedback: { type: 'explicit-instruction', instruction: '배포해줘', appliesTo: 'verbosity' },
    });
    expect(outcome.changed).toBe(false);
  });
});

describe('evolvePersona — correction / positive / negative / implicit / domain-exposure', () => {
  it('correction adds a learnedBehavior', () => {
    const p = freshPersona();
    evolvePersona({
      persona: p,
      feedback: {
        type: 'correction',
        original: 'X',
        corrected: 'Y',
        pattern: 'user asked about X',
      },
    });
    expect(p.learnedBehaviors).toHaveLength(1);
    expect(p.learnedBehaviors[0]?.source).toBe('correction');
  });

  it('positive feedback nudges proactivity up', () => {
    const p = freshPersona();
    evolvePersona({
      persona: p,
      feedback: { type: 'positive-feedback', context: 'morning', behavior: 'schedule summary' },
    });
    expect(p.communicationStyle.proactivity).toBeGreaterThan(0.5);
  });

  it('strong negative nudges proactivity down more than mild', () => {
    const p1 = freshPersona();
    const p2 = freshPersona();
    evolvePersona({
      persona: p1,
      feedback: { type: 'negative-feedback', context: '', behavior: '', severity: 'mild' },
    });
    evolvePersona({
      persona: p2,
      feedback: { type: 'negative-feedback', context: '', behavior: '', severity: 'strong' },
    });
    expect(0.5 - p2.communicationStyle.proactivity).toBeGreaterThan(0.5 - p1.communicationStyle.proactivity);
  });

  it('implicit feedback records a behavior at low confidence', () => {
    const p = freshPersona();
    evolvePersona({
      persona: p,
      feedback: { type: 'implicit', observation: 'always X first', suggestedBehavior: 'Y' },
    });
    expect(p.learnedBehaviors).toHaveLength(1);
    expect(p.learnedBehaviors[0]?.source).toBe('implicit');
    expect(p.learnedBehaviors[0]?.confidence).toBeLessThan(0.5);
  });

  it('domain-exposure adds a new expertise entry', () => {
    const p = freshPersona();
    evolvePersona({
      persona: p,
      feedback: { type: 'domain-exposure', domain: 'baking', subtopic: 'bread', interactionCount: 5 },
    });
    expect(p.domainExpertise).toHaveLength(1);
    expect(p.domainExpertise[0]?.domain).toBe('baking');
  });

  it('domain-exposure on an existing domain adds a subtopic and bumps confidence', () => {
    const p = freshPersona({
      domainExpertise: [
        {
          domain: 'baking',
          confidence: 0.3,
          subTopics: ['bread'],
          learnedFrom: 3,
          lastActive: new Date().toISOString(),
        },
      ],
    });
    evolvePersona({
      persona: p,
      feedback: { type: 'domain-exposure', domain: 'baking', subtopic: 'cookies', interactionCount: 2 },
    });
    expect(p.domainExpertise[0]?.confidence).toBeCloseTo(0.35);
    expect(p.domainExpertise[0]?.subTopics).toContain('cookies');
  });
});

describe('§4.6 opposite-direction detection', () => {
  it('emits needsConfirmation when a reversal exceeds confirmThreshold', () => {
    const p = freshPersona();
    // Three clear "down" nudges first (verbosity).
    evolvePersona({
      persona: p,
      feedback: { type: 'explicit-instruction', instruction: '더 간결하게', appliesTo: 'verbosity' },
    });
    evolvePersona({
      persona: p,
      feedback: { type: 'explicit-instruction', instruction: '더 간결하게', appliesTo: 'verbosity' },
    });
    evolvePersona({
      persona: p,
      feedback: { type: 'explicit-instruction', instruction: '더 간결하게', appliesTo: 'verbosity' },
    });
    // Now reverse — sum of |down deltas| ≈ 0.3, plus incoming +0.1 → triggers flip.
    const outcome = evolvePersona({
      persona: p,
      feedback: { type: 'explicit-instruction', instruction: '더 상세히', appliesTo: 'verbosity' },
    });
    expect(outcome.needsConfirmation?.field).toBe('communicationStyle.verbosity');
    expect(outcome.changed).toBe(false);
  });
});

describe('§4.2 reinforcement + §4.7 maturity scale', () => {
  it('new-relationship evolution is halved', () => {
    const p1 = freshPersona({ relationshipContext: { ...freshPersona().relationshipContext, communicationMaturity: 'new' } });
    const p2 = freshPersona({ relationshipContext: { ...freshPersona().relationshipContext, communicationMaturity: 'established' } });
    evolvePersona({
      persona: p1,
      feedback: { type: 'explicit-instruction', instruction: '더 간결하게', appliesTo: 'verbosity' },
    });
    evolvePersona({
      persona: p2,
      feedback: { type: 'explicit-instruction', instruction: '더 간결하게', appliesTo: 'verbosity' },
    });
    const d1 = 0.5 - p1.communicationStyle.verbosity;
    const d2 = 0.5 - p2.communicationStyle.verbosity;
    expect(d2).toBeGreaterThan(d1);
  });
});

describe('applyDecay', () => {
  it('decays confidence on behaviors older than decayDays', () => {
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const recent = new Date().toISOString();
    const p = freshPersona({
      learnedBehaviors: [
        { trigger: 'a', learned: 'x', confidence: 0.8, source: 'correction', learnedAt: old },
        { trigger: 'b', learned: 'y', confidence: 0.8, source: 'correction', learnedAt: recent },
      ],
    });
    const n = applyDecay(p, { decayDays: 30, decayRate: 0.1 });
    expect(n).toBe(1);
    expect(p.learnedBehaviors[0]?.confidence).toBeLessThan(0.8);
    expect(p.learnedBehaviors[1]?.confidence).toBe(0.8);
  });
});

describe('DEFAULT_EVOLUTION_RULES sanity', () => {
  it('has safe clamp-friendly defaults', () => {
    expect(DEFAULT_EVOLUTION_RULES.maxDeltaPerEvent).toBeLessThan(0.2);
    expect(DEFAULT_EVOLUTION_RULES.reinforcementThreshold).toBeGreaterThanOrEqual(2);
  });
});
