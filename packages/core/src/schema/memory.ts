import { Type, type Static } from '@sinclair/typebox';

export const SearchContext = Type.Object({
  sessionId: Type.String(),
  agentId: Type.String(),
  recentTopics: Type.Array(Type.String()),
  preferredWings: Type.Optional(Type.Array(Type.String())),
  maxResults: Type.Integer({ minimum: 1 }),
  minRelevanceScore: Type.Number({ minimum: 0, maximum: 1 }),
});
export type SearchContext = Static<typeof SearchContext>;

export const MemorySearchResult = Type.Object({
  content: Type.String(),
  source: Type.Object({
    wing: Type.String(),
    file: Type.String(),
    lineRange: Type.Tuple([Type.Integer(), Type.Integer()]),
  }),
  relevance: Type.Object({
    bm25Score: Type.Number(),
    vectorScore: Type.Number(),
    structureBoost: Type.Number(),
    combinedScore: Type.Number(),
  }),
  metadata: Type.Object({
    createdAt: Type.String(),
    lastAccessedAt: Type.String(),
    accessCount: Type.Integer({ minimum: 0 }),
  }),
});
export type MemorySearchResult = Static<typeof MemorySearchResult>;

export const ConversationTurn = Type.Object({
  sessionId: Type.String(),
  userMessage: Type.String(),
  agentResponse: Type.String(),
  timestamp: Type.Integer({ minimum: 0 }),
});
export type ConversationTurn = Static<typeof ConversationTurn>;

export const IngestResult = Type.Object({
  chunksAdded: Type.Integer({ minimum: 0 }),
  chunksUpdated: Type.Integer({ minimum: 0 }),
  classifications: Type.Array(Type.String()),
});
export type IngestResult = Static<typeof IngestResult>;

export const ClassificationResult = Type.Object({
  wing: Type.String(),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  subcategory: Type.Optional(Type.String()),
});
export type ClassificationResult = Static<typeof ClassificationResult>;

export const MessageSummary = Type.Object({
  role: Type.Union([Type.Literal('user'), Type.Literal('assistant'), Type.Literal('system')]),
  text: Type.String(),
  timestamp: Type.Integer({ minimum: 0 }),
});
export type MessageSummary = Static<typeof MessageSummary>;

export const TurnSummary = MessageSummary;
export type TurnSummary = MessageSummary;
