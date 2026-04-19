import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { FileGoalStore } from './goal-store.js';

describe('FileGoalStore', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'ego-goals-'));
    path = resolve(dir, 'goals.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts empty', async () => {
    const store = new FileGoalStore(path);
    expect(await store.list()).toEqual([]);
  });

  it('creates and reads a goal', async () => {
    const store = new FileGoalStore(path);
    const g = await store.create({
      description: 'ship v1',
      status: 'active',
      progress: 0,
      relatedSessionIds: [],
      createdBy: 'user',
    });
    expect(g.id).toMatch(/^goal-/);
    expect(g.createdAt).toBeGreaterThan(0);
    const fetched = await store.get(g.id);
    expect(fetched?.description).toBe('ship v1');
  });

  it('filters by status', async () => {
    const store = new FileGoalStore(path);
    await store.create({
      description: 'a',
      status: 'active',
      progress: 0,
      relatedSessionIds: [],
      createdBy: 'user',
    });
    await store.create({
      description: 'b',
      status: 'completed',
      progress: 1,
      relatedSessionIds: [],
      createdBy: 'user',
    });
    const active = await store.list({ status: 'active' });
    expect(active).toHaveLength(1);
    expect(active[0]?.description).toBe('a');
  });

  it('update preserves id and createdAt', async () => {
    const store = new FileGoalStore(path);
    const g = await store.create({
      description: 'x',
      status: 'active',
      progress: 0,
      relatedSessionIds: [],
      createdBy: 'user',
    });
    const updated = await store.update(g.id, { progress: 0.5 });
    expect(updated.id).toBe(g.id);
    expect(updated.createdAt).toBe(g.createdAt);
    expect(updated.progress).toBe(0.5);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(g.createdAt);
  });

  it('archive transitions status to abandoned', async () => {
    const store = new FileGoalStore(path);
    const g = await store.create({
      description: 'x',
      status: 'active',
      progress: 0,
      relatedSessionIds: [],
      createdBy: 'user',
    });
    await store.archive(g.id);
    const fetched = await store.get(g.id);
    expect(fetched?.status).toBe('abandoned');
  });

  it('persists across reload', async () => {
    const first = new FileGoalStore(path);
    await first.create({
      description: 'persistent',
      status: 'active',
      progress: 0,
      relatedSessionIds: [],
      createdBy: 'ego',
    });
    await new Promise((r) => setTimeout(r, 50));
    const second = new FileGoalStore(path);
    const all = await second.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.description).toBe('persistent');
  });
});
