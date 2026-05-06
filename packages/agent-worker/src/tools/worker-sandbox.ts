import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { Contracts, SandboxInstance, SessionPolicy, ToolResult } from '@agent-platform/core';
import { generateId, nowMs } from '@agent-platform/core';

type ToolSandbox = Contracts.ToolSandbox;

/**
 * What the parent needs to know about a worker-runnable tool: where its source
 * lives (for dynamic-import inside the worker) and which exported tool to
 * invoke. `LiveToolRegistry` and the skill mounter populate this map alongside
 * the in-process `Map<string, AgentTool>` so dispatch can route per tool.
 */
export interface WorkerToolSpec {
  /** ESM-importable URL — typically `pathToFileURL(<installDir>/<entryPoint>).href`. */
  moduleUrl: string;
  /** Tool name as exported by `createTools()`. Used to pick the right tool from the array. */
  toolName: string;
  /** Skill manifest id — surfaced as `ctx.manifest.id` inside the worker (read-only). */
  manifestId?: string;
  /** Skill install dir — surfaced as `ctx.installDir`. Worker code is responsible for honoring it. */
  installDir?: string;
  /**
   * Per-tool resourceLimits override. Falls back to sandbox-level config, then
   * to {@link DEFAULT_RESOURCE_LIMITS}.
   */
  resourceLimits?: WorkerResourceLimits;
}

/**
 * Subset of node:worker_threads `ResourceLimits` we explicitly support. We
 * intentionally don't expose `stackSizeMb` — it's brittle across Node versions.
 */
export interface WorkerResourceLimits {
  maxOldGenerationSizeMb?: number;
  maxYoungGenerationSizeMb?: number;
  /** Max code size loaded into the isolate. */
  codeRangeSizeMb?: number;
}

export interface WorkerSandboxConfig {
  /**
   * Default resourceLimits applied to every worker unless the spec overrides.
   * Defaults: 256MB old / 32MB young / 64MB code range.
   */
  resourceLimits?: WorkerResourceLimits;
  /**
   * Override the path to the worker entry. Tests use this to inject a
   * compiled-on-the-fly runner; production callers leave it unset and the
   * sibling `worker-sandbox-runner.js` is used.
   */
  runnerUrl?: URL;
  /**
   * When `true`, the worker inherits the parent's `process.env`. Default
   * `false` — the worker gets an empty env. Skills should obtain credentials
   * via `args` after the parent has performed a capability check, not via
   * env spelunking.
   */
  shareEnv?: boolean;
}

const DEFAULT_RESOURCE_LIMITS: Required<WorkerResourceLimits> = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  codeRangeSizeMb: 64,
};

interface WorkerReplyOk {
  id: string;
  ok: true;
  value: unknown;
}
interface WorkerReplyErr {
  id: string;
  ok: false;
  error: string;
  errorName?: string;
}
type WorkerReply = WorkerReplyOk | WorkerReplyErr;

/**
 * `worker_threads`-backed `ToolSandbox`. Each `execute()` spawns a fresh
 * worker, posts the args, awaits the single reply, then terminates the worker.
 * No cross-call state, no pool — agent-authored skills get a clean V8 isolate
 * per call, capped by `resourceLimits`.
 *
 * Security model (capability + isolation):
 *   - V8 heap isolation prevents skill code from poking parent globals
 *     directly. `process.env`, `process.binding`, etc. on the worker side are
 *     a *separate* `process` object whose env is inherited but read-only at the
 *     V8 level — to actually exfiltrate env, the skill would need
 *     filesystem/network capabilities, which `PolicyCapabilityGuard` denies in
 *     the parent before we ever spawn.
 *   - Timeout enforcement is `Worker.terminate()` on the parent side. The
 *     tool's `ctx.signal` inside the worker is a noop AbortSignal — the worker
 *     gets no cooperative cancellation channel because IPC may not be flushed
 *     when terminate() fires.
 *   - resourceLimits caps memory; the OOM kills the worker, parent treats it
 *     as a failed result.
 *
 * What this *doesn't* protect against:
 *   - fs/net access if the skill imports `node:fs`/`node:net` and the parent
 *     authorized those paths/hosts. That's PolicyCapabilityGuard's job.
 *   - Side channels through SharedArrayBuffer if skill code is able to obtain
 *     one. We do not opt skills into transferList APIs, so absent shared
 *     memory, only structuredClone'd values cross the boundary.
 */
export class WorkerSandbox implements ToolSandbox {
  private readonly instances = new Map<
    string,
    { instance: SandboxInstance; policy: SessionPolicy }
  >();

  constructor(
    private readonly tools: Map<string, WorkerToolSpec>,
    private readonly config: WorkerSandboxConfig = {},
  ) {}

  async acquire(
    policy: SessionPolicy,
    trace?: Contracts.TraceCallContext,
  ): Promise<SandboxInstance> {
    const instance: SandboxInstance = {
      id: `workerbox-${generateId()}`,
      status: 'ready',
      startedAt: nowMs(),
      resourceUsage: { cpuSeconds: 0, memoryMb: 0, diskMb: 0 },
    };
    this.instances.set(instance.id, { instance, policy });
    if (trace) {
      trace.traceLogger.event({
        traceId: trace.traceId,
        ...(trace.sessionId !== undefined ? { sessionId: trace.sessionId } : {}),
        ...(trace.agentId !== undefined ? { agentId: trace.agentId } : {}),
        block: 'S1',
        event: 'sandbox_acquired',
        timestamp: Date.now(),
        summary: `worker sandbox '${instance.id}' acquired (trustLevel=${policy.trustLevel})`,
        payload: { sandboxId: instance.id, kind: 'worker', trustLevel: policy.trustLevel },
      });
    }
    return instance;
  }

  async execute(
    sandbox: SandboxInstance,
    toolName: string,
    args: unknown,
    timeoutMs: number,
    trace?: Contracts.TraceCallContext,
  ): Promise<ToolResult> {
    const registered = this.instances.get(sandbox.id);
    if (!registered) {
      return { toolName, success: false, error: 'sandbox not acquired', durationMs: 0 };
    }
    const spec = this.tools.get(toolName);
    if (!spec) {
      return { toolName, success: false, error: `unknown tool: ${toolName}`, durationMs: 0 };
    }

    registered.instance.status = 'running';
    const start = performance.now();
    let result: ToolResult;
    try {
      const value = await this.runOnce(spec, args, timeoutMs, sandbox.id);
      // Skills can return either a wrapped ToolResult (rare — skill author opted in)
      // or a plain value that we wrap. Same convention as `adaptSkillTool`.
      if (value && typeof value === 'object' && 'toolName' in (value as object)) {
        const wrapped = value as ToolResult;
        result = { ...wrapped, durationMs: performance.now() - start };
      } else {
        result = {
          toolName,
          success: true,
          output: JSON.stringify(value ?? null),
          durationMs: performance.now() - start,
        };
      }
    } catch (err) {
      const e = err as Error;
      result = {
        toolName,
        success: false,
        error: e.message,
        durationMs: performance.now() - start,
      };
    } finally {
      registered.instance.status = 'ready';
    }
    if (trace) {
      trace.traceLogger.event({
        traceId: trace.traceId,
        ...(trace.sessionId !== undefined ? { sessionId: trace.sessionId } : {}),
        ...(trace.agentId !== undefined ? { agentId: trace.agentId } : {}),
        block: 'S1',
        event: 'sandbox_executed',
        timestamp: Date.now(),
        durationMs: Math.round(result.durationMs),
        summary: `worker exec '${toolName}' → ${result.success ? 'ok' : 'error'} in ${Math.round(result.durationMs)}ms${result.success ? '' : `: ${(result.error ?? 'unknown').slice(0, 40)}`}`,
        payload: {
          sandboxId: sandbox.id,
          tool: toolName,
          success: result.success,
          ...(result.error !== undefined ? { error: result.error } : {}),
        },
      });
    }
    return result;
  }

  async release(sandbox: SandboxInstance, trace?: Contracts.TraceCallContext): Promise<void> {
    this.instances.delete(sandbox.id);
    if (trace) {
      trace.traceLogger.event({
        traceId: trace.traceId,
        ...(trace.sessionId !== undefined ? { sessionId: trace.sessionId } : {}),
        ...(trace.agentId !== undefined ? { agentId: trace.agentId } : {}),
        block: 'S1',
        event: 'sandbox_released',
        timestamp: Date.now(),
        summary: `worker sandbox '${sandbox.id}' released`,
        payload: { sandboxId: sandbox.id, kind: 'worker' },
      });
    }
  }

  private async runOnce(
    spec: WorkerToolSpec,
    args: unknown,
    timeoutMs: number,
    sandboxId: string,
  ): Promise<unknown> {
    const limits = {
      ...DEFAULT_RESOURCE_LIMITS,
      ...(this.config.resourceLimits ?? {}),
      ...(spec.resourceLimits ?? {}),
    };
    const runnerUrl = this.config.runnerUrl ?? defaultRunnerUrl();
    const runnerPath = fileURLToPath(runnerUrl);
    const isTsRunner = runnerPath.endsWith('.ts');

    const worker = new Worker(runnerPath, {
      workerData: {
        moduleUrl: spec.moduleUrl,
        toolName: spec.toolName,
        ...(spec.manifestId !== undefined ? { manifestId: spec.manifestId } : {}),
        ...(spec.installDir !== undefined ? { installDir: spec.installDir } : {}),
      },
      resourceLimits: limits,
      // Strip the parent process.env from the worker. Skills should not see
      // host secrets (API keys, GATEWAY_TOKEN, etc.) — what they need must
      // come through `args` after a capability check. `env: {}` gives the
      // worker an empty env. (`SHARE_ENV` symbol from worker_threads would
      // inherit; we deliberately don't.)
      env: this.config.shareEnv ? undefined : {},
      // Node 22.7+ strips types unflagged, but pass it explicitly so older
      // 22.x patch versions still work in dev / vitest scenarios.
      ...(isTsRunner ? { execArgv: ['--experimental-strip-types', '--no-warnings'] } : {}),
      // Stdout/stderr from skills go to the worker's own pipes; we discard
      // them so they don't pollute the parent log unless explicitly captured.
      stdout: true,
      stderr: true,
    });

    const id = generateId();

    return new Promise((resolveOnce, rejectOnce) => {
      let settled = false;
      const settle = (mode: 'resolve' | 'reject', payload: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.removeAllListeners();
        // Best-effort terminate; if worker exits cleanly this is a noop.
        worker.terminate().catch(() => undefined);
        if (mode === 'resolve') resolveOnce(payload);
        else rejectOnce(payload as Error);
      };

      const timer = setTimeout(() => {
        settle('reject', new Error(`worker timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      worker.on('message', (raw: unknown) => {
        const reply = raw as WorkerReply;
        if (reply.id !== id) return; // stale message — shouldn't happen with per-execute spawn
        if (reply.ok) settle('resolve', reply.value);
        else {
          const err = new Error(reply.error);
          if (reply.errorName) err.name = reply.errorName;
          settle('reject', err);
        }
      });

      worker.on('error', (err) => settle('reject', err));

      worker.on('exit', (code) => {
        if (settled) return;
        if (code !== 0) {
          settle(
            'reject',
            new Error(`worker exited with code ${code} (sandbox ${sandboxId}) before reply`),
          );
        } else {
          settle('reject', new Error('worker exited without sending reply'));
        }
      });

      worker.postMessage({
        id,
        args,
        ctx: { sessionId: '', agentId: '', traceId: sandboxId },
      });
    });
  }
}

function defaultRunnerUrl(): URL {
  // import.meta.url ends with .ts in dev/test (vitest, tsx) and .js in
  // production (after tsc → dist/). The sibling runner shares the extension,
  // so we mirror it. This avoids the "build before test" gotcha.
  const self = new URL(import.meta.url);
  const isTs = self.pathname.endsWith('.ts');
  return new URL(
    isTs ? './worker-sandbox-runner.ts' : './worker-sandbox-runner.js',
    import.meta.url,
  );
}
