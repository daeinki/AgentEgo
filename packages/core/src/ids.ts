import { randomUUID } from 'node:crypto';
import {
  asAgentId,
  asEgoDecisionId,
  asGoalId,
  asMessageId,
  asPersonaId,
  asSessionId,
  asTraceId,
  type AgentId,
  type EgoDecisionId,
  type GoalId,
  type MessageId,
  type PersonaId,
  type SessionId,
  type TraceId,
} from './brand.js';

function uuidv7(): string {
  const ms = Date.now();
  const randomBytes = randomUUID().replace(/-/g, '');
  const tsHex = ms.toString(16).padStart(12, '0');
  const rand = randomBytes.slice(12);
  const hex =
    tsHex.slice(0, 8) +
    '-' +
    tsHex.slice(8, 12) +
    '-7' +
    rand.slice(0, 3) +
    '-' +
    ((parseInt(rand.slice(3, 5), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') +
    rand.slice(5, 7) +
    '-' +
    rand.slice(7, 19);
  return hex;
}

export function generateId(): string {
  return uuidv7();
}

export function generateSessionId(): SessionId {
  return asSessionId(`sess-${uuidv7()}`);
}

export function generateTraceId(): TraceId {
  return asTraceId(`trc-${uuidv7()}`);
}

export function generateGoalId(): GoalId {
  return asGoalId(`goal-${uuidv7()}`);
}

export function generateEgoDecisionId(): EgoDecisionId {
  return asEgoDecisionId(`ego-${uuidv7()}`);
}

export function generateMessageId(): MessageId {
  return asMessageId(uuidv7());
}

export function generateAgentId(slug: string): AgentId {
  return asAgentId(`agent-${slug}`);
}

export function generatePersonaId(): PersonaId {
  const hex = randomUUID().replace(/-/g, '').slice(0, 6);
  return asPersonaId(`prs-${hex}`);
}
