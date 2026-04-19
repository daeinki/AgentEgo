import { Type, type Static } from '@sinclair/typebox';

const ratio = () => Type.Number({ minimum: 0, maximum: 1 });

export const CommunicationStyle = Type.Object({
  formality: ratio(),
  verbosity: ratio(),
  humor: ratio(),
  empathy: ratio(),
  directness: ratio(),
  proactivity: ratio(),
  preferredLanguage: Type.String(),
  adaptToUser: Type.Boolean(),
});
export type CommunicationStyle = Static<typeof CommunicationStyle>;

export const EmotionalTendencies = Type.Object({
  defaultMood: Type.String(),
  sensitivityToFrustration: ratio(),
  celebrationLevel: ratio(),
  cautiousness: ratio(),
  curiosity: ratio(),
  patience: ratio(),
});
export type EmotionalTendencies = Static<typeof EmotionalTendencies>;

export const ValuePriorities = Type.Object({
  accuracy: ratio(),
  speed: ratio(),
  privacy: ratio(),
  creativity: ratio(),
  costEfficiency: ratio(),
  safety: ratio(),
  autonomy: ratio(),
});
export type ValuePriorities = Static<typeof ValuePriorities>;

export const DomainExpertise = Type.Object({
  domain: Type.String(),
  confidence: ratio(),
  subTopics: Type.Array(Type.String()),
  learnedFrom: Type.Integer({ minimum: 0 }),
  lastActive: Type.String(),
});
export type DomainExpertise = Static<typeof DomainExpertise>;

export const LearnedBehavior = Type.Object({
  trigger: Type.String(),
  learned: Type.String(),
  confidence: ratio(),
  source: Type.Union([
    Type.Literal('correction'),
    Type.Literal('positive-feedback'),
    Type.Literal('negative-feedback'),
    Type.Literal('explicit-instruction'),
    Type.Literal('implicit'),
  ]),
  learnedAt: Type.String(),
});
export type LearnedBehavior = Static<typeof LearnedBehavior>;

export const RelationshipContext = Type.Object({
  interactionStartDate: Type.String(),
  trustLevel: ratio(),
  communicationMaturity: Type.Union([
    Type.Literal('new'),
    Type.Literal('developing'),
    Type.Literal('established'),
  ]),
  knownPreferences: Type.Array(Type.String()),
  knownDislikes: Type.Array(Type.String()),
  insideJokes: Type.Array(Type.String()),
  milestones: Type.Array(
    Type.Object({
      event: Type.String(),
      date: Type.String(),
      impact: Type.Union([
        Type.Literal('positive'),
        Type.Literal('negative'),
        Type.Literal('neutral'),
      ]),
    }),
  ),
});
export type RelationshipContext = Static<typeof RelationshipContext>;

export const EvolutionLogEntry = Type.Object({
  timestamp: Type.String(),
  trigger: Type.String(),
  change: Type.Object({
    field: Type.String(),
    from: Type.Optional(Type.Unknown()),
    to: Type.Optional(Type.Unknown()),
    delta: Type.Optional(Type.Number()),
    action: Type.Optional(Type.String()),
    domain: Type.Optional(Type.String()),
    subtopic: Type.Optional(Type.String()),
  }),
  reason: Type.String(),
});
export type EvolutionLogEntry = Static<typeof EvolutionLogEntry>;

export const Persona = Type.Object({
  version: Type.String(),
  personaId: Type.String({ pattern: '^prs-' }),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  totalInteractions: Type.Integer({ minimum: 0 }),
  evolutionCount: Type.Integer({ minimum: 0 }),
  identity: Type.Object({
    name: Type.String(),
    role: Type.String(),
    coreDirective: Type.String(),
  }),
  communicationStyle: CommunicationStyle,
  emotionalTendencies: EmotionalTendencies,
  valuePriorities: ValuePriorities,
  domainExpertise: Type.Array(DomainExpertise),
  learnedBehaviors: Type.Array(LearnedBehavior),
  relationshipContext: RelationshipContext,
  evolutionLog: Type.Array(EvolutionLogEntry),
});
export type Persona = Static<typeof Persona>;

export const PersonaSnapshot = Type.Object({
  summary: Type.String(),
  relevantBehaviors: Type.Array(Type.String()),
  relevantExpertise: Type.Array(Type.String()),
  estimatedTokens: Type.Integer({ minimum: 0 }),
});
export type PersonaSnapshot = Static<typeof PersonaSnapshot>;

// ─── Persona feedback (§4.1 — 6-variant union) ─────────────────────────────

export const PersonaFeedback = Type.Union([
  Type.Object({
    type: Type.Literal('explicit-instruction'),
    instruction: Type.String(),
    appliesTo: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('correction'),
    original: Type.String(),
    corrected: Type.String(),
    pattern: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('positive-feedback'),
    context: Type.String(),
    behavior: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('negative-feedback'),
    context: Type.String(),
    behavior: Type.String(),
    severity: Type.Union([Type.Literal('mild'), Type.Literal('strong')]),
  }),
  Type.Object({
    type: Type.Literal('implicit'),
    observation: Type.String(),
    suggestedBehavior: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('domain-exposure'),
    domain: Type.String(),
    subtopic: Type.String(),
    interactionCount: Type.Integer({ minimum: 0 }),
  }),
]);
export type PersonaFeedback = Static<typeof PersonaFeedback>;

export const EvolutionRules = Type.Object({
  maxDeltaPerEvent: Type.Number({ minimum: 0, maximum: 1 }),
  inertiaFactor: Type.Number({ minimum: 0, maximum: 1 }),
  reinforcementThreshold: Type.Integer({ minimum: 1 }),
  decayDays: Type.Integer({ minimum: 1 }),
  decayRate: Type.Number({ minimum: 0, maximum: 1 }),
  confirmThreshold: Type.Number({ minimum: 0, maximum: 1 }),
  confirmWindowCount: Type.Integer({ minimum: 1 }),
});
export type EvolutionRules = Static<typeof EvolutionRules>;

// ─── Style presets (§8) ────────────────────────────────────────────────────

export const STYLE_PRESETS = {
  'casual-friendly': {
    communicationStyle: {
      formality: 0.3,
      verbosity: 0.3,
      humor: 0.7,
      empathy: 0.8,
      directness: 0.6,
      proactivity: 0.5,
    },
    emotionalTendencies: { defaultMood: 'warm-cheerful', curiosity: 0.8, patience: 0.9 },
  },
  'professional-concise': {
    communicationStyle: {
      formality: 0.8,
      verbosity: 0.2,
      humor: 0.2,
      empathy: 0.5,
      directness: 0.9,
      proactivity: 0.3,
    },
    emotionalTendencies: { defaultMood: 'calm-neutral', curiosity: 0.5, patience: 0.7 },
  },
  'creative-expressive': {
    communicationStyle: {
      formality: 0.2,
      verbosity: 0.6,
      humor: 0.8,
      empathy: 0.7,
      directness: 0.5,
      proactivity: 0.7,
    },
    emotionalTendencies: { defaultMood: 'enthusiastic', curiosity: 0.9, patience: 0.8 },
  },
  'analytical-precise': {
    communicationStyle: {
      formality: 0.6,
      verbosity: 0.5,
      humor: 0.1,
      empathy: 0.4,
      directness: 0.8,
      proactivity: 0.4,
    },
    emotionalTendencies: { defaultMood: 'focused-neutral', curiosity: 0.7, patience: 0.6 },
    valuePriorities: { accuracy: 1.0, speed: 0.4 },
  },
} as const satisfies Record<string, unknown>;

export type StylePresetName = keyof typeof STYLE_PRESETS;
