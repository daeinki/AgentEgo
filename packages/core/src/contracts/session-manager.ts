import type {
  Session,
  SessionPatch,
  SessionEvent,
  SessionEventInput,
  LoadHistoryOptions,
  CreateSessionParams,
  CompactionResult,
} from '../types/session.js';
import type { StandardMessage } from '../types/message.js';

export interface SessionManager {
  /**
   * 메시지의 (agentId, channelType, conversationId) 튜플로 기존 세션을 조회·반환.
   * 히트 실패 시 createSession. status='hibernated' 히트 시 자동 resumeSession.
   * inactivity 타임아웃을 초과해도 같은 튜플이면 재사용('active' 로 전이).
   * 새 대화는 CLI `agent session reset` 으로 기존 세션을 archived 로 보낸 뒤 신규 생성.
   * (ADR-010)
   */
  resolveSession(msg: StandardMessage): Promise<Session>;
  getSession(sessionId: string): Promise<Session | null>;
  createSession(params: CreateSessionParams): Promise<Session>;
  updateSession(sessionId: string, patch: SessionPatch): Promise<Session>;

  /**
   * ADR-010: session_events 에 단일 이벤트를 append. INSERT only (UPDATE/UPSERT 금지).
   * 실패 시 throw — 호출자는 retry 없이 턴 실패로 전파한다.
   * 반환값은 DB 가 부여한 autoincrement id.
   */
  appendEvent(sessionId: string, event: SessionEventInput): Promise<number>;

  /**
   * ADR-010: 세션 이력을 시간 오름차순으로 반환.
   *   - honorCompaction (기본 true): 최신 compaction 이벤트 이후만 반환.
   *   - includeKinds (기본값 DEFAULT_PROMPT_EVENT_KINDS): 'reasoning_step' 기본 제외.
   *   - limit (기본 100, 최대 500).
   */
  loadHistory(sessionId: string, opts?: LoadHistoryOptions): Promise<SessionEvent[]>;

  compactSession(sessionId: string): Promise<CompactionResult>;
  hibernateSession(sessionId: string): Promise<void>;
  resumeSession(sessionId: string): Promise<Session>;
  sendToSession(fromId: string, toId: string, msg: string): Promise<void>;
}
