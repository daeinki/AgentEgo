import { describe, it, expect } from 'vitest';
import { SchedulerService, type SchedulerRunEvent } from './scheduler.js';
import type { CronTask, TaskRunResult, TaskRunner } from './types.js';

type ChatTask = Extract<CronTask, { type: 'chat' }>;

function chatTask(overrides: Partial<ChatTask> = {}): ChatTask {
  return {
    id: overrides.id ?? 'test-task',
    spec: overrides.spec ?? '* * * * *',
    enabled: overrides.enabled ?? true,
    type: 'chat',
    chat: overrides.chat ?? { prompt: 'hi' },
    ...(overrides.description !== undefined ? { description: overrides.description } : {}),
  };
}

function scriptedRunner(results: TaskRunResult[]): TaskRunner {
  let i = 0;
  return {
    type: 'chat',
    async run() {
      const r = results[i] ?? results[results.length - 1] ?? { ok: true };
      i += 1;
      return r;
    },
  };
}

describe('SchedulerService — list() / history derivation', () => {
  it('lists a disabled task as status=disabled without registering it', () => {
    const svc = new SchedulerService({
      tasks: [chatTask({ id: 't1', enabled: false })],
      runners: { chat: scriptedRunner([]) },
    });
    const d = svc.list();
    expect(d).toHaveLength(1);
    expect(d[0]?.status).toBe('disabled');
  });

  it('enabled + no runs yet → status=idle', () => {
    const svc = new SchedulerService({
      tasks: [chatTask({ id: 't-idle' })],
      runners: { chat: scriptedRunner([]) },
    });
    expect(svc.list()[0]?.status).toBe('idle');
  });
});

describe('SchedulerService — runNow dispatch', () => {
  it('invokes the matching runner and records lastRunAt + summary', async () => {
    const events: SchedulerRunEvent[] = [];
    const svc = new SchedulerService({
      tasks: [chatTask({ id: 'now-ok' })],
      runners: { chat: scriptedRunner([{ ok: true, summary: 'did it' }]) },
      onRun: (e) => events.push(e),
    });
    const { startedAt } = await svc.runNow('now-ok');
    expect(typeof startedAt).toBe('number');
    // dispatch is async — give the microtask queue a tick
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(1);
    expect(events[0]?.ok).toBe(true);
    expect(events[0]?.summary).toBe('did it');
    const d = svc.get('now-ok');
    expect(d?.lastRunAt).toBeGreaterThan(0);
    expect(d?.status).toBe('idle');
  });

  it('failed runner captures error in history + flips status to error', async () => {
    const svc = new SchedulerService({
      tasks: [chatTask({ id: 'now-bad' })],
      runners: { chat: scriptedRunner([{ ok: false, error: 'boom' }]) },
    });
    await svc.runNow('now-bad');
    await new Promise((r) => setImmediate(r));
    const d = svc.get('now-bad');
    expect(d?.status).toBe('error');
    expect(d?.lastError).toBe('boom');
  });

  it('throwing runner is caught and reported as error', async () => {
    const throwing: TaskRunner = {
      type: 'chat',
      async run() {
        throw new Error('unexpected');
      },
    };
    const svc = new SchedulerService({
      tasks: [chatTask({ id: 'throws' })],
      runners: { chat: throwing },
    });
    await svc.runNow('throws');
    await new Promise((r) => setImmediate(r));
    expect(svc.get('throws')?.lastError).toBe('unexpected');
  });

  it('runNow on unknown task id throws', async () => {
    const svc = new SchedulerService({ tasks: [], runners: { chat: scriptedRunner([]) } });
    await expect(svc.runNow('nope')).rejects.toThrow(/unknown task/);
  });

  it('runNow rejects overlapping invocations for the same id', async () => {
    // Slow runner holds `running=true` long enough for a second runNow to race.
    const slow: TaskRunner = {
      type: 'chat',
      async run() {
        await new Promise((r) => setTimeout(r, 30));
        return { ok: true };
      },
    };
    const svc = new SchedulerService({
      tasks: [chatTask({ id: 'slow' })],
      runners: { chat: slow },
    });
    await svc.runNow('slow');
    // Immediate second runNow must reject because the first is still running.
    await expect(svc.runNow('slow')).rejects.toThrow(/already running/);
  });

  it('successful run clears a prior lastError', async () => {
    const svc = new SchedulerService({
      tasks: [chatTask({ id: 'recover' })],
      runners: {
        chat: scriptedRunner([
          { ok: false, error: 'first' },
          { ok: true, summary: 'second' },
        ]),
      },
    });
    await svc.runNow('recover');
    await new Promise((r) => setImmediate(r));
    expect(svc.get('recover')?.lastError).toBe('first');
    await svc.runNow('recover');
    await new Promise((r) => setImmediate(r));
    expect(svc.get('recover')?.lastError).toBeUndefined();
    expect(svc.get('recover')?.status).toBe('idle');
  });
});

describe('SchedulerService — start() validation', () => {
  it('throws when a task references a runner type that is not registered', () => {
    const svc = new SchedulerService({
      tasks: [chatTask({ id: 't' })],
      // no runners at all
      runners: {},
    });
    expect(() => svc.start()).toThrow(/no runner registered/);
  });

  it('throws when spec is not a valid cron expression', () => {
    const svc = new SchedulerService({
      tasks: [chatTask({ id: 't', spec: 'not-a-cron' })],
      runners: { chat: scriptedRunner([]) },
    });
    expect(() => svc.start()).toThrow(/invalid cron spec/);
  });

  it('double-start is idempotent', async () => {
    const svc = new SchedulerService({
      tasks: [chatTask({ id: 't' })],
      runners: { chat: scriptedRunner([]) },
    });
    svc.start();
    svc.start();
    await svc.stop();
  });
});
