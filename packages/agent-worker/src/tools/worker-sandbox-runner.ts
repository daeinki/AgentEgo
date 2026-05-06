import { parentPort, workerData } from 'node:worker_threads';

/**
 * Worker entry point used by `WorkerSandbox`. Runs in a fresh V8 isolate per
 * spawn (per-execute model), so there is no cross-call state to worry about.
 *
 * Lifecycle:
 *  1. Parent passes `workerData = { moduleUrl, toolName, manifestId? }`.
 *  2. We dynamic-import `moduleUrl` and call its `createTools({manifest, installDir})`
 *     factory to find the tool with the requested name.
 *  3. Parent posts a single `{ id, args, ctx }` message → we invoke
 *     `tool.execute(args, ctx)` and post back `{ id, ok: true, value }` or
 *     `{ id, ok: false, error }`. Parent then `terminate()`s the worker.
 *
 * The runner never reads back-channel state (env, fs, etc.) — capability
 * checks happen in the parent before we are even spawned. We deliberately do
 * not surface `process.env` or any host globals into the tool's `ctx` either.
 */

interface WorkerInit {
  moduleUrl: string;
  toolName: string;
  manifestId?: string;
  installDir?: string;
}

interface WorkerExecMsg {
  id: string;
  args: unknown;
  ctx: { sessionId: string; agentId: string; traceId: string };
}

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

interface RawTool {
  name: string;
  execute?: (args: unknown, ctx: unknown) => Promise<unknown>;
  call?: (args: unknown, ctx: unknown) => Promise<unknown>;
}

interface SkillModuleShape {
  createTools(ctx: { manifest: unknown; installDir: string }): RawTool[];
}

if (!parentPort) {
  throw new Error('worker-sandbox-runner must be spawned as a worker_thread');
}

const init = workerData as WorkerInit;

let toolFnPromise: Promise<(args: unknown, ctx: unknown) => Promise<unknown>> | null = null;

function loadTool(): Promise<(args: unknown, ctx: unknown) => Promise<unknown>> {
  if (!toolFnPromise) {
    toolFnPromise = (async () => {
      const mod = (await import(init.moduleUrl)) as SkillModuleShape;
      if (typeof mod.createTools !== 'function') {
        throw new Error(`module ${init.moduleUrl} does not export createTools()`);
      }
      const tools = mod.createTools({
        manifest: { id: init.manifestId ?? 'unknown' },
        installDir: init.installDir ?? '',
      });
      if (!Array.isArray(tools)) {
        throw new Error(`createTools() did not return an array (module ${init.moduleUrl})`);
      }
      const found = tools.find((t) => t.name === init.toolName);
      if (!found) {
        throw new Error(`tool '${init.toolName}' not exported by ${init.moduleUrl}`);
      }
      const handler = found.execute ?? found.call;
      if (typeof handler !== 'function') {
        throw new Error(`tool '${init.toolName}' has no execute()/call() handler`);
      }
      return handler.bind(found);
    })();
  }
  return toolFnPromise;
}

parentPort.on('message', async (raw: unknown) => {
  const msg = raw as WorkerExecMsg;
  try {
    const fn = await loadTool();
    // Worker has no AbortSignal — cancellation happens via Worker.terminate()
    // from the parent on timeout. The tool's `ctx.signal` is therefore a noop
    // signal here; this is documented in WorkerSandbox.execute.
    const noopController = new AbortController();
    const ctx = { ...msg.ctx, signal: noopController.signal };
    const value = await fn(msg.args, ctx);
    const reply: WorkerReplyOk = { id: msg.id, ok: true, value };
    parentPort!.postMessage(reply);
  } catch (err) {
    const e = err as Error;
    const reply: WorkerReplyErr = {
      id: msg.id,
      ok: false,
      error: e.message ?? String(err),
      ...(e.name ? { errorName: e.name } : {}),
    };
    parentPort!.postMessage(reply);
  }
});
