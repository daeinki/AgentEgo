import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Contracts, Goal, GoalStatus } from '@agent-platform/core';
import { generateGoalId, nowMs } from '@agent-platform/core';

type GoalStore = Contracts.GoalStore;

interface GoalFileShape {
  version: '1.0.0';
  goals: Goal[];
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

/**
 * JSON-file backed GoalStore (ADR-007). Simple, single-writer; serializes all
 * writes through an internal promise chain to avoid interleaved writes within
 * the same process.
 */
export class FileGoalStore implements GoalStore {
  private readonly path: string;
  private goals: Goal[] | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(storePath: string) {
    this.path = expandHome(storePath);
  }

  private async ensureLoaded(): Promise<Goal[]> {
    if (this.goals) return this.goals;
    try {
      const raw = await readFile(this.path, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<GoalFileShape>;
      this.goals = Array.isArray(parsed.goals) ? parsed.goals : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.goals = [];
      } else {
        throw err;
      }
    }
    return this.goals;
  }

  private async flush(): Promise<void> {
    const goals = this.goals ?? [];
    await mkdir(dirname(this.path), { recursive: true });
    const payload: GoalFileShape = { version: '1.0.0', goals };
    await writeFile(this.path, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(work);
    this.writeChain = next.catch(() => {});
    return next;
  }

  async list(filter?: { status?: GoalStatus }): Promise<Goal[]> {
    const all = await this.ensureLoaded();
    if (!filter?.status) return [...all];
    return all.filter((g) => g.status === filter.status);
  }

  async get(id: string): Promise<Goal | null> {
    const all = await this.ensureLoaded();
    return all.find((g) => g.id === id) ?? null;
  }

  async create(g: Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>): Promise<Goal> {
    await this.ensureLoaded();
    const now = nowMs();
    const goal: Goal = {
      ...g,
      id: generateGoalId(),
      createdAt: now,
      updatedAt: now,
    };
    this.goals!.push(goal);
    await this.enqueue(() => this.flush());
    return goal;
  }

  async update(id: string, patch: Partial<Goal>): Promise<Goal> {
    await this.ensureLoaded();
    const idx = this.goals!.findIndex((g) => g.id === id);
    if (idx < 0) throw new Error(`Goal ${id} not found`);
    const existing = this.goals![idx]!;
    const merged: Goal = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: nowMs(),
    };
    this.goals![idx] = merged;
    await this.enqueue(() => this.flush());
    return merged;
  }

  async archive(id: string): Promise<void> {
    await this.update(id, { status: 'abandoned' });
  }
}
