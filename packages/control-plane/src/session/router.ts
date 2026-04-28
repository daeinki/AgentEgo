import type {
  Contracts,
  RouteDecision,
  RoutingRule,
  StandardMessage,
} from '@agent-platform/core';
import { SessionStore } from './store.js';

type RouterContract = Contracts.Router;

export interface RouterOptions {
  defaultAgentId: string;
  /**
   * Optional initial rules. The router sorts rules by priority (higher first)
   * and returns the first match.
   */
  rules?: RoutingRule[];
  /** Optional trace logger — emits a `C1 decision` event on each route. */
  traceLogger?: Contracts.TraceLogger;
}

/**
 * Rule-based router (harness §3.2.3). A RoutingRule matches against the
 * incoming StandardMessage; on match, its target.agentId is selected. On no
 * match, the defaultAgentId is used. Session is resolved via SessionStore.
 */
export class RuleRouter implements RouterContract {
  private rules: RoutingRule[] = [];

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly options: RouterOptions,
  ) {
    if (options.rules) {
      for (const rule of options.rules) this.addRule(rule);
    }
  }

  async route(msg: StandardMessage): Promise<RouteDecision> {
    const matched = this.firstMatchingRule(msg);
    const agentId = matched?.target.agentId ?? this.options.defaultAgentId;
    const session = this.sessionStore.resolveSession(
      agentId,
      msg.channel.type,
      msg.conversation.id,
    );

    this.options.traceLogger?.event({
      traceId: msg.traceId,
      sessionId: session.id,
      agentId,
      block: 'C1',
      event: 'decision',
      timestamp: Date.now(),
      summary: matched
        ? `routed to agent='${agentId}' via rule '${matched.id}' (priority=${matched.priority})`
        : `routed to default agent='${agentId}' (no rule matched)`,
      payload: {
        matchedRuleId: matched?.id ?? null,
        priority: matched?.priority ?? 0,
      },
    });

    return {
      agentId,
      sessionId: session.id,
      priority: matched?.priority ?? 0,
      capabilities: [],
    };
  }

  addRule(rule: RoutingRule): void {
    // Reject duplicates by id; higher priority first.
    this.rules = this.rules.filter((r) => r.id !== rule.id);
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  removeRule(ruleId: string): void {
    this.rules = this.rules.filter((r) => r.id !== ruleId);
  }

  listRules(): readonly RoutingRule[] {
    return this.rules;
  }

  private firstMatchingRule(msg: StandardMessage): RoutingRule | undefined {
    return this.rules.find((r) => ruleMatches(r, msg));
  }
}

function ruleMatches(rule: RoutingRule, msg: StandardMessage): boolean {
  const c = rule.conditions;
  if (c.channelType && !c.channelType.includes(msg.channel.type)) return false;
  if (c.senderIds && !c.senderIds.includes(msg.sender.id)) return false;
  if (c.conversationIds && !c.conversationIds.includes(msg.conversation.id)) return false;
  if (c.contentPattern) {
    const text = contentText(msg);
    if (!text) return false;
    try {
      if (!new RegExp(c.contentPattern, 'i').test(text)) return false;
    } catch {
      // Malformed regex → no match (rather than crash the router)
      return false;
    }
  }
  return true;
}

function contentText(msg: StandardMessage): string {
  switch (msg.content.type) {
    case 'text':
      return msg.content.text;
    case 'command':
      return `/${msg.content.name} ${msg.content.args.join(' ')}`.trimEnd();
    case 'media':
      return msg.content.caption ?? '';
    case 'reaction':
      return msg.content.emoji;
  }
}

/**
 * Legacy synchronous router kept for backward compatibility with the CLI's
 * `send` command. Delegates to SessionStore.resolveSession directly without
 * running rules. New code should use RuleRouter.
 */
export class Router {
  constructor(
    private sessionStore: SessionStore,
    private defaultAgentId: string = 'default',
  ) {}

  route(msg: StandardMessage): { agentId: string; sessionId: string; priority: number } {
    const session = this.sessionStore.resolveSession(
      this.defaultAgentId,
      msg.channel.type,
      msg.conversation.id,
    );
    return {
      agentId: this.defaultAgentId,
      sessionId: session.id,
      priority: 1,
    };
  }
}
