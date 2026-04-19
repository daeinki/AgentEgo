export type Brand<T, B extends string> = T & { readonly __brand: B };

export type SessionId = Brand<string, 'SessionId'>;
export type TraceId = Brand<string, 'TraceId'>;
export type GoalId = Brand<string, 'GoalId'>;
export type EgoDecisionId = Brand<string, 'EgoDecisionId'>;
export type PersonaId = Brand<string, 'PersonaId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type AgentId = Brand<string, 'AgentId'>;

export const asSessionId = (s: string): SessionId => s as SessionId;
export const asTraceId = (s: string): TraceId => s as TraceId;
export const asGoalId = (s: string): GoalId => s as GoalId;
export const asEgoDecisionId = (s: string): EgoDecisionId => s as EgoDecisionId;
export const asPersonaId = (s: string): PersonaId => s as PersonaId;
export const asMessageId = (s: string): MessageId => s as MessageId;
export const asAgentId = (s: string): AgentId => s as AgentId;
