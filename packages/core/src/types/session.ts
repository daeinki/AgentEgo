import { Type, type Static } from '@sinclair/typebox';

export const SessionStatus = Type.Union([
  Type.Literal('active'),
  Type.Literal('hibernated'),
  Type.Literal('archived'),
  Type.Literal('redirected'),
]);
export type SessionStatus = Static<typeof SessionStatus>;

export const Session = Type.Object({
  id: Type.String(),
  agentId: Type.String(),
  channelType: Type.String(),
  conversationId: Type.String(),
  status: SessionStatus,
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type Session = Static<typeof Session>;

export const SessionPatch = Type.Object({
  status: Type.Optional(SessionStatus),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type SessionPatch = Static<typeof SessionPatch>;

export const SessionEventType = Type.Union([
  Type.Literal('user_message'),
  Type.Literal('agent_response'),
  Type.Literal('tool_call'),
  Type.Literal('tool_result'),
  Type.Literal('reasoning_step'), // ADR-010: Reasoner trace persistence (관측 전용)
  Type.Literal('compaction'),
  Type.Literal('system'),
]);
export type SessionEventType = Static<typeof SessionEventType>;

export const SessionEventRole = Type.Union([
  Type.Literal('user'),
  Type.Literal('assistant'),
  Type.Literal('system'),
  Type.Literal('tool'),
]);
export type SessionEventRole = Static<typeof SessionEventRole>;

export const SessionEvent = Type.Object({
  id: Type.Optional(Type.Number()),
  sessionId: Type.String(),
  eventType: SessionEventType,
  role: SessionEventRole,
  content: Type.String(),
  tokenCount: Type.Optional(Type.Number()),
  costUsd: Type.Optional(Type.Number()),
  traceId: Type.Optional(Type.String()),
  createdAt: Type.Number(),
});
export type SessionEvent = Static<typeof SessionEvent>;

// ADR-010: SessionManager.appendEvent 입력 — sessionId/id 없음, createdAt 은 optional
// (구현체가 부여 가능). content 는 JSON-직렬화 결과 문자열.
export const SessionEventInput = Type.Object({
  eventType: SessionEventType,
  role: SessionEventRole,
  content: Type.String(),
  tokenCount: Type.Optional(Type.Number()),
  costUsd: Type.Optional(Type.Number()),
  traceId: Type.Optional(Type.String()),
  createdAt: Type.Optional(Type.Number()),
});
export type SessionEventInput = Static<typeof SessionEventInput>;

// ADR-010: SessionManager.loadHistory 옵션
//   - includeKinds 기본값은 프롬프트 재구성에 필요한 turn 이벤트만:
//     ['user_message','agent_response','tool_call','tool_result','compaction']
//     (reasoning_step 은 관측 전용이므로 기본 제외)
//   - honorCompaction: true 면 최신 compaction 이벤트 이후만 반환
export const LoadHistoryOptions = Type.Object({
  sinceId: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
  includeKinds: Type.Optional(Type.Array(SessionEventType)),
  honorCompaction: Type.Optional(Type.Boolean()),
});
export type LoadHistoryOptions = Static<typeof LoadHistoryOptions>;

// 기본 프롬프트 재구성용 이벤트 종류 (reasoning_step 제외)
export const DEFAULT_PROMPT_EVENT_KINDS: SessionEventType[] = [
  'user_message',
  'agent_response',
  'tool_call',
  'tool_result',
  'compaction',
];

export const CreateSessionParams = Type.Object({
  agentId: Type.String(),
  channelType: Type.String(),
  conversationId: Type.String(),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type CreateSessionParams = Static<typeof CreateSessionParams>;

export const CompactionResult = Type.Object({
  sessionId: Type.String(),
  removedEvents: Type.Number(),
  summaryEventId: Type.Optional(Type.Number()),
  tokensBefore: Type.Number(),
  tokensAfter: Type.Number(),
});
export type CompactionResult = Static<typeof CompactionResult>;
