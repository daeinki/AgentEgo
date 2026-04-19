import type { Goal, GoalStatus } from '../schema/goal.js';

export interface GoalStore {
  list(filter?: { status?: GoalStatus }): Promise<Goal[]>;
  get(id: string): Promise<Goal | null>;
  create(g: Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>): Promise<Goal>;
  update(id: string, patch: Partial<Goal>): Promise<Goal>;
  archive(id: string): Promise<void>;
}
