import type { StandardMessage } from '../types/message.js';
import type { RouteDecision, RoutingRule } from '../schema/routing.js';

export interface Router {
  route(msg: StandardMessage): Promise<RouteDecision>;
  addRule(rule: RoutingRule): void;
  removeRule(ruleId: string): void;
}
