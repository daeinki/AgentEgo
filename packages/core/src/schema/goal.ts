import { Type, type Static } from '@sinclair/typebox';

export const GoalStatus = Type.Union([
  Type.Literal('active'),
  Type.Literal('paused'),
  Type.Literal('completed'),
  Type.Literal('abandoned'),
]);
export type GoalStatus = Static<typeof GoalStatus>;

export const Goal = Type.Object({
  id: Type.String({ pattern: '^goal-' }),
  description: Type.String({ minLength: 1 }),
  status: GoalStatus,
  createdAt: Type.Integer({ minimum: 0 }),
  updatedAt: Type.Integer({ minimum: 0 }),
  progress: Type.Number({ minimum: 0, maximum: 1 }),
  completionCriteria: Type.Optional(Type.String()),
  relatedSessionIds: Type.Array(Type.String()),
  createdBy: Type.Union([Type.Literal('user'), Type.Literal('ego')]),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type Goal = Static<typeof Goal>;

export const GoalUpdate = Type.Object({
  goalId: Type.String({ pattern: '^goal-' }),
  progressDelta: Type.Number({ minimum: -1, maximum: 1 }),
  notes: Type.Optional(Type.String()),
});
export type GoalUpdate = Static<typeof GoalUpdate>;
