import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolResult } from '@agent-platform/core';
import { ownerPolicy } from '../security/capability-guard.js';
import { WorkerSandbox, type WorkerSandboxConfig, type WorkerToolSpec } from './worker-sandbox.js';
import type { AgentTool } from './types.js';

/**
 * Same regex-level static checks used by `skill.create`. Kept private to
 * avoid a public dependency between the two modules — they evolve together
 * but neither needs to know about the other.
 */
const FORBIDDEN_SOURCE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\beval\s*\(/, reason: 'eval() is forbidden' },
  { re: /\bnew\s+Function\s*\(/, reason: 'new Function() is forbidden' },
  { re: /\bchild_process\b/, reason: 'child_process imports are forbidden' },
  { re: /\bprocess\.binding\b/, reason: 'process.binding is forbidden' },
  { re: /\brequire\s*\(/, reason: 'CommonJS require() is forbidden (use ESM import)' },
];
const IMPORT_LINE_RE = /^\s*import\s+(?:[^'"]+?from\s+)?['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(/;

function staticCheckSource(src: string): { ok: true } | { ok: false; reason: string } {
  for (const { re, reason } of FORBIDDEN_SOURCE_PATTERNS) {
    if (re.test(src)) return { ok: false, reason };
  }
  if (DYNAMIC_IMPORT_RE.test(src)) return { ok: false, reason: 'dynamic import() is forbidden' };
  IMPORT_LINE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMPORT_LINE_RE.exec(src)) !== null) {
    const spec = match[1] ?? '';
    if (!(spec.startsWith('node:') || spec.startsWith('@agent-platform/'))) {
      return {
        ok: false,
        reason: `import "${spec}" is not in the allow-list (node:*, @agent-platform/*)`,
      };
    }
  }
  return { ok: true };
}

export interface CodeExecToolDeps {
  /**
   * WorkerSandbox config — passed to each per-call sandbox the tool builds
   * (tests use this to inject a custom runnerUrl or tighter resourceLimits).
   * Each `code.exec` call gets a fresh `WorkerSandbox` instance keyed by a
   * one-off tool name, so no state leaks between concurrent calls.
   */
  workerConfig?: WorkerSandboxConfig;
  /**
   * Override default timeout (ms). Default 5000. Per-call `args.timeoutMs`
   * still overrides this, capped at {@link TIMEOUT_CEILING_MS}.
   */
  defaultTimeoutMs?: number;
}

interface CodeExecArgs {
  sourceCode: string;
  /** Args forwarded to the snippet's `main` tool. */
  input?: unknown;
  /** Per-call timeout override. Capped at 30s to bound runaway snippets. */
  timeoutMs?: number;
}

const TIMEOUT_CEILING_MS = 30_000;
const SNIPPET_TOOL_NAME = 'main';
const SNIPPET_SESSION = 'code-exec';

/**
 * `code.exec` — run a single-shot ESM snippet in a fresh worker, no install.
 *
 * The snippet must be a complete ESM module that exports `createTools()`
 * returning at least one tool named `'main'`. Same shape as `skill.create`,
 * but the module is written to a tmp dir and deleted after the call — there's
 * no registry mutation, no remount, nothing visible to future turns.
 *
 * Threat model:
 *   - All forbidden-source patterns from `skill.create` apply. eval / new
 *     Function / child_process / process.binding / require / dynamic import
 *     are rejected before the worker ever spawns.
 *   - Import allow-list: `node:*` and `@agent-platform/*` only. Snippet can't
 *     pull arbitrary npm deps (they wouldn't resolve from the tmp dir anyway).
 *   - Worker-level isolation: V8 isolate + `resourceLimits` (256MB old / 32MB
 *     young) + `terminate()` on timeout.
 *   - No filesystem.write permission declared — the host capability guard
 *     should not authorize this tool to mutate user data. The tmp file we
 *     write is internal scaffolding, not part of the agent's argument
 *     surface.
 */
export function codeExecTool(deps: CodeExecToolDeps = {}): AgentTool<CodeExecArgs> {
  const workerConfig = deps.workerConfig ?? {};
  const defaultTimeout = deps.defaultTimeoutMs ?? 5_000;

  return {
    name: 'code.exec',
    description:
      'Run a single-shot ESM snippet in an isolated worker thread. The snippet must ' +
      "export `createTools()` returning at least one tool named 'main'. The 'main' " +
      "tool's `execute(args, ctx)` is called with `args = input` and its return value " +
      'is the result of this tool. Use this when you need to run a small computation ' +
      'for the current turn without installing a permanent skill (which would only ' +
      'be available next turn). Imports limited to node:* and @agent-platform/*.',
    riskLevel: 'high',
    permissions: [],
    inputSchema: {
      type: 'object',
      required: ['sourceCode'],
      properties: {
        sourceCode: {
          type: 'string',
          description:
            'Complete ESM module source. Must export createTools() returning at least ' +
            "one tool named 'main' with async execute(args, ctx). Allowed imports: node:*, @agent-platform/*.",
        },
        input: {
          description:
            "Forwarded to the snippet's main.execute(args). Any JSON-serializable value.",
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: TIMEOUT_CEILING_MS,
          description: `Override timeout (ms). Default ${defaultTimeout}, hard cap ${TIMEOUT_CEILING_MS}.`,
        },
      },
    },
    async execute(args): Promise<ToolResult> {
      const start = performance.now();
      const check = staticCheckSource(args.sourceCode);
      if (!check.ok) {
        return {
          toolName: 'code.exec',
          success: false,
          error: `source rejected by static check: ${check.reason}`,
          durationMs: performance.now() - start,
        };
      }
      const timeout = Math.min(args.timeoutMs ?? defaultTimeout, TIMEOUT_CEILING_MS);

      const stagingDir = mkdtempSync(join(tmpdir(), 'code-exec-'));
      const modulePath = join(stagingDir, 'snippet.mjs');
      writeFileSync(modulePath, args.sourceCode, 'utf-8');
      const moduleUrl = pathToFileURL(modulePath).href;

      const spec: WorkerToolSpec = {
        moduleUrl,
        toolName: SNIPPET_TOOL_NAME,
        manifestId: 'code-exec',
        installDir: stagingDir,
      };
      // Per-call WorkerSandbox so we don't mutate any shared tools map and
      // multiple code.exec calls in flight can't collide on the same key.
      const perCallSandbox = new WorkerSandbox(new Map([[SNIPPET_TOOL_NAME, spec]]), workerConfig);

      try {
        const inst = await perCallSandbox.acquire(ownerPolicy(SNIPPET_SESSION));
        try {
          const result = await perCallSandbox.execute(
            inst,
            SNIPPET_TOOL_NAME,
            args.input ?? null,
            timeout,
          );
          return {
            toolName: 'code.exec',
            success: result.success,
            ...(result.output !== undefined ? { output: result.output } : {}),
            ...(result.error !== undefined ? { error: result.error } : {}),
            durationMs: performance.now() - start,
          };
        } finally {
          await perCallSandbox.release(inst);
        }
      } catch (err) {
        return {
          toolName: 'code.exec',
          success: false,
          error: (err as Error).message,
          durationMs: performance.now() - start,
        };
      } finally {
        rmSync(stagingDir, { recursive: true, force: true });
      }
    },
  };
}

// Exported for test access — not part of the public tool surface.
export const __testing__ = { staticCheckSource };
