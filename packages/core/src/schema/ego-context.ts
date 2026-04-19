import { Type, type Static } from '@sinclair/typebox';
import { Goal } from './goal.js';
import { MemorySearchResult, MessageSummary } from './memory.js';
import { EgoFullConfig } from '../types/ego.js';

/**
 * EGO 파이프라인에 입력되는 컨텍스트.
 *
 * `recentHistory` 는 ADR-010 (harness-engineering.md §3.2.2) 의 SessionManager
 * `loadHistory()` 결과를 요약한 뷰이다. EGO 는 session_events 를 직접 쿼리하지
 * 않으며, 호출자가 이 필드를 채워 전달한다.
 */
export const EgoContext = Type.Object({
  sessionId: Type.String(),
  agentId: Type.String(),
  egoConfig: EgoFullConfig,
  recentHistory: Type.Array(MessageSummary),
  memoryHints: Type.Array(MemorySearchResult),
  activeGoals: Type.Array(Goal),
});
export type EgoContext = Static<typeof EgoContext>;
