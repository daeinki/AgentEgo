import type {
  Contracts,
  EgoDecisionId,
  MessageSummary,
  StandardMessage,
} from '@agent-platform/core';
import { generateSessionId, nowMs } from '@agent-platform/core';

type SessionManager = Contracts.SessionManager;
type AuditLog = Contracts.AuditLog;

export interface RedirectParams {
  egoDecisionId: EgoDecisionId;
  traceId: string;
  originalSessionId: string;
  originalMessage: StandardMessage;
  targetAgentId: string;
  targetSessionId?: string | undefined;
  reason: string;
  recentHistory: MessageSummary[];
  sessions: SessionManager;
  audit?: AuditLog;
}

export interface RedirectResult {
  fromSessionId: string;
  toSessionId: string;
  announcementText: string;
}

function summarizeHistory(history: MessageSummary[], max = 3): string {
  if (!history.length) return '(이전 대화 요약 없음)';
  return history
    .slice(-max)
    .map((m) => `[${m.role}] ${m.text}`)
    .join('\n');
}

/**
 * Execute a redirect decision per harness §3.2A.5a.
 *
 * 1. Mark original session as 'redirected' with metadata.
 * 2. Create target session if missing.
 * 3. Seed target with recent history as a system event (best-effort via sendToSession).
 * 4. Produce an announcement text for the caller to publish to the user.
 * 5. Audit.
 */
export async function performRedirect(params: RedirectParams): Promise<RedirectResult> {
  const targetSessionId = params.targetSessionId ?? generateSessionId();

  await params.sessions.updateSession(params.originalSessionId, {
    status: 'redirected',
    metadata: {
      redirectedTo: targetSessionId,
      reason: params.reason,
      egoDecisionId: params.egoDecisionId,
      redirectedAt: nowMs(),
    },
  });

  const existing = await params.sessions.getSession(targetSessionId);
  if (!existing) {
    await params.sessions.createSession({
      agentId: params.targetAgentId,
      channelType: params.originalMessage.channel.type,
      conversationId: params.originalMessage.conversation.id,
      metadata: {
        redirectedFrom: params.originalSessionId,
        egoDecisionId: params.egoDecisionId,
      },
    });
  }

  // Best-effort: emit a system preamble. Swallow failures so redirect isn't blocked.
  try {
    await params.sessions.sendToSession(
      params.originalSessionId,
      targetSessionId,
      `[system] 이전 세션 요약:\n${summarizeHistory(params.recentHistory)}`,
    );
  } catch {
    // non-fatal
  }

  const announcementText = `이 요청은 ${params.targetAgentId} 에이전트가 더 적합합니다. 전환합니다.`;

  await params.audit?.record({
    timestamp: nowMs(),
    traceId: params.traceId,
    tag: 'ego_redirect',
    actor: 'ego',
    action: 'session.redirect',
    result: 'success',
    riskLevel: 'medium',
    sessionId: params.originalSessionId,
    agentId: params.targetAgentId,
    egoDecisionId: params.egoDecisionId,
    parameters: {
      toSessionId: targetSessionId,
      reason: params.reason,
    },
  });

  return {
    fromSessionId: params.originalSessionId,
    toSessionId: targetSessionId,
    announcementText,
  };
}
