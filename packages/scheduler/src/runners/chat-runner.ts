import type { Contracts, StandardMessage } from '@agent-platform/core';
import { generateId, generateTraceId, nowMs } from '@agent-platform/core';
import type {
  MessageHandler,
  MessageHandlerContext,
} from '@agent-platform/control-plane';
import type { CronTask, TaskRunContext, TaskRunResult, TaskRunner } from '../types.js';

export interface ChatTaskRunnerDeps {
  /** The same `handler` `platform.ts` builds — runs EGO + AgentRunner. */
  handler: MessageHandler;
  /** Used to resolve agent + session ids (same path as JSON-RPC chat.send). */
  router: Contracts.Router;
  /** Optional per-turn debug trace logger. */
  traceLogger?: Contracts.TraceLogger;
}

type ChatTask = Extract<CronTask, { type: 'chat' }>;

/**
 * Dispatches a cron-triggered chat turn by synthesizing a `StandardMessage`
 * and calling the platform's existing `MessageHandler`, which already wraps
 * EGO + AgentRunner. Behavior-wise a scheduled chat turn is indistinguishable
 * from a JSON-RPC `chat.send` call.
 *
 * Session semantics:
 *   - `sessionStrategy: 'pinned'` (default) — conversationId is
 *     `task.chat.sessionId ?? 'cron-<taskId>'`, so turns accumulate in one
 *     session.
 *   - `sessionStrategy: 'fresh'` — new conversationId per run
 *     (`cron-<taskId>-<timestamp>`), so history never accumulates.
 *
 * Response deltas are discarded (scheduler has no client to stream to). The
 * agent's response is still persisted via SessionStore and the trace log.
 */
export class ChatTaskRunner implements TaskRunner<ChatTask> {
  readonly type = 'chat' as const;

  constructor(private readonly deps: ChatTaskRunnerDeps) {}

  async run(task: ChatTask, ctx: TaskRunContext): Promise<TaskRunResult> {
    const { prompt, agentId: agentIdOverride, senderId, sessionStrategy = 'pinned' } = task.chat;
    const conversationId =
      sessionStrategy === 'fresh'
        ? `cron-${task.id}-${ctx.startedAt}`
        : (task.chat.sessionId ?? `cron-${task.id}`);

    const msg: StandardMessage = {
      id: generateId(),
      traceId: generateTraceId(),
      timestamp: nowMs(),
      channel: {
        type: 'webchat',
        id: `cron:${task.id}`,
        metadata: { _cronTaskId: task.id, _cronTrigger: ctx.trigger },
      },
      sender: { id: senderId ?? `cron-${task.id}`, isOwner: true },
      conversation: { type: 'dm', id: conversationId },
      content: { type: 'text', text: prompt },
    };

    const route = await this.deps.router.route(msg);
    const agentId = agentIdOverride ?? route.agentId;
    const sessionId = route.sessionId;

    const handlerCtx: MessageHandlerContext = {
      sessionId,
      agentId,
      traceId: msg.traceId,
      emit: () => {},
      ...(this.deps.traceLogger ? { traceLogger: this.deps.traceLogger } : {}),
    };

    try {
      const usage = await this.deps.handler(msg, handlerCtx);
      const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      return {
        ok: true,
        summary: `chat ok (session=${sessionId}, tokens=${tokens})`,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
