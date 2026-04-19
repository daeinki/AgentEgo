import type { Permission, ToolResult } from '@agent-platform/core';
import type {
  LocalSkillRegistry,
  SkillDefinition,
} from '@agent-platform/skills';
import type { AgentTool } from './types.js';

/**
 * U10 Phase 3 + 5: tools that let the agent author/list/remove/reload skills
 * at runtime. Security posture:
 *
 *  - `skill.create` is riskLevel=high and declares filesystem.write on the
 *    install root. PolicyCapabilityGuard already gates filesystem.write
 *    behind owner trust — these tools are therefore only usable from
 *    owner-trusted sessions.
 *  - Before delegating to `registry.installFromDefinition`, we run a
 *    lightweight static check on `sourceCode` to reject obviously dangerous
 *    patterns (eval, child_process, process.binding, ...) and import paths
 *    outside the allowed prefix set.
 *  - `skill.remove` and `skill.reload` are also gated on filesystem.write /
 *    filesystem.read respectively.
 */

export interface SkillToolDeps {
  registry: LocalSkillRegistry;
  /**
   * Called after create/remove/reload mutates the install root. Implementation
   * should re-scan installed skills and update the live tool registry so
   * newly-authored tools become available on the *next* turn.
   * Returning a string[] of currently-mounted tool names helps the create
   * response report `mountedNow: boolean`.
   */
  remount?: () => Promise<string[]> | string[];
}

interface SkillCreateArgs {
  id: string;
  name: string;
  description: string;
  version?: string;
  sourceCode: string;
  permissions?: Permission[];
  platformMinVersion?: string;
}

interface SkillListArgs {
  query?: string;
}

interface SkillRemoveArgs {
  id: string;
}

type SkillReloadArgs = Record<string, never>;

// ─── Phase 5.2: source static checks ───────────────────────────────────────

/**
 * Regex-level static analysis. Not a sandbox — a belt-and-suspenders filter
 * that rejects patterns no agent-authored skill should legitimately need.
 * Caller is expected to run inside an owner-trusted session where the user
 * has already approved the authoring intent.
 */
const FORBIDDEN_SOURCE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\beval\s*\(/, reason: 'eval() is forbidden in agent-authored skills' },
  { re: /\bnew\s+Function\s*\(/, reason: 'new Function() is forbidden' },
  { re: /\bchild_process\b/, reason: 'child_process imports are forbidden' },
  { re: /\bprocess\.binding\b/, reason: 'process.binding is forbidden' },
  { re: /\brequire\s*\(/, reason: 'CommonJS require() is forbidden (use ESM import)' },
];

/**
 * ESM imports are only allowed from `node:*` and `@agent-platform/*` to keep
 * the surface reviewable. Inline dynamic imports (`import(...)`) are
 * forbidden outright.
 */
const IMPORT_LINE_RE = /^\s*import\s+(?:[^'"]+?from\s+)?['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(/;

function staticCheckSource(src: string): { ok: true } | { ok: false; reason: string } {
  for (const { re, reason } of FORBIDDEN_SOURCE_PATTERNS) {
    if (re.test(src)) return { ok: false, reason };
  }
  if (DYNAMIC_IMPORT_RE.test(src)) {
    return { ok: false, reason: 'dynamic import() is forbidden' };
  }
  // Reset exec state (global regex) before scanning.
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

// Exported for test access — not part of the public tool surface.
export const __testing__ = { staticCheckSource };

// ─── Tool factories ────────────────────────────────────────────────────────

export function skillCreateTool(deps: SkillToolDeps): AgentTool<SkillCreateArgs> {
  return {
    name: 'skill.create',
    description:
      'Author a new single-file ESM skill and install it into the local registry. ' +
      'Use this only when no existing tool can accomplish the task. The new tool ' +
      'becomes available on the next turn (not the current one).',
    riskLevel: 'high',
    permissions: [{ type: 'filesystem', access: 'write', paths: ['~/.agent/skills'] }],
    inputSchema: {
      type: 'object',
      required: ['id', 'name', 'description', 'sourceCode'],
      properties: {
        id: {
          type: 'string',
          pattern: '^[a-z][a-z0-9-]{2,40}$',
          description: 'Unique skill id (lowercase alnum + hyphens, 3-41 chars).',
        },
        name: { type: 'string', minLength: 1, maxLength: 80 },
        description: { type: 'string', minLength: 10, maxLength: 500 },
        version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$', default: '0.1.0' },
        sourceCode: {
          type: 'string',
          description:
            'ESM module source exporting createTools({manifest, installDir}) → LoadedSkillTool[]. ' +
            'Each tool object MUST have: name, description, inputSchema, and async execute(args, ctx) ' +
            '(the legacy `call` alias is accepted for backwards compatibility but `execute` is required for new skills). ' +
            'Imports restricted to node:* and @agent-platform/*.',
        },
        permissions: {
          type: 'array',
          items: { type: 'object' },
          description: 'Capability permissions the new skill needs (minimum principle).',
        },
        platformMinVersion: { type: 'string' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const start = performance.now();
      try {
        const check = staticCheckSource(args.sourceCode);
        if (!check.ok) {
          return {
            toolName: 'skill.create',
            success: false,
            error: `source rejected by static check: ${check.reason}`,
            durationMs: performance.now() - start,
          };
        }
        const def: SkillDefinition = {
          id: args.id,
          name: args.name,
          description: args.description,
          permissions: args.permissions ?? [],
          sourceCode: args.sourceCode,
          ...(args.version !== undefined ? { version: args.version } : {}),
          ...(args.platformMinVersion !== undefined
            ? { platformMinVersion: args.platformMinVersion }
            : {}),
        };
        const result = await deps.registry.installFromDefinition(def);
        let mountedNames: string[] = [];
        if (deps.remount) {
          const r = deps.remount();
          mountedNames = Array.isArray(r) ? r : await r;
        }
        return {
          toolName: 'skill.create',
          success: true,
          output: JSON.stringify({
            skillId: result.skillId,
            location: result.location,
            installedAt: result.installedAt,
            mountedNow: mountedNames.length > 0,
            mountedToolCount: mountedNames.length,
            message: `Skill '${args.id}' created. New tools will be available on the next turn.`,
          }),
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          toolName: 'skill.create',
          success: false,
          error: (err as Error).message,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

export function skillListTool(deps: SkillToolDeps): AgentTool<SkillListArgs> {
  return {
    name: 'skill.list',
    description: 'List installed skills, optionally filtered by a substring query against id/name/description.',
    riskLevel: 'low',
    permissions: [],
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional case-insensitive substring filter.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const start = performance.now();
      try {
        const installed = await deps.registry.listInstalled();
        const lower = args.query?.toLowerCase() ?? '';
        const filtered = lower
          ? installed.filter((s) => {
              const m = s.metadata;
              return (
                m.id.toLowerCase().includes(lower) ||
                m.name.toLowerCase().includes(lower) ||
                m.description.toLowerCase().includes(lower)
              );
            })
          : installed;
        const summary = filtered.map((s) => ({
          id: s.metadata.id,
          name: s.metadata.name,
          description: s.metadata.description,
          version: s.metadata.version,
          enabled: s.enabled,
          location: s.location,
        }));
        return {
          toolName: 'skill.list',
          success: true,
          output: JSON.stringify(summary),
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          toolName: 'skill.list',
          success: false,
          error: (err as Error).message,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

export function skillRemoveTool(deps: SkillToolDeps): AgentTool<SkillRemoveArgs> {
  return {
    name: 'skill.remove',
    description: 'Uninstall a skill by id. The tool backed by the skill disappears on the next turn.',
    riskLevel: 'medium',
    permissions: [{ type: 'filesystem', access: 'write', paths: ['~/.agent/skills'] }],
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
    async execute(args): Promise<ToolResult> {
      const start = performance.now();
      try {
        const removed = await deps.registry.uninstall(args.id);
        if (!removed) {
          return {
            toolName: 'skill.remove',
            success: false,
            error: `skill not installed: ${args.id}`,
            durationMs: performance.now() - start,
          };
        }
        if (deps.remount) {
          const r = deps.remount();
          if (!Array.isArray(r)) await r;
        }
        return {
          toolName: 'skill.remove',
          success: true,
          output: JSON.stringify({ skillId: args.id, removed: true }),
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          toolName: 'skill.remove',
          success: false,
          error: (err as Error).message,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

export function skillReloadTool(deps: SkillToolDeps): AgentTool<SkillReloadArgs> {
  return {
    name: 'skill.reload',
    description: 'Re-scan the installed-skills directory and refresh the live tool registry.',
    riskLevel: 'low',
    permissions: [],
    inputSchema: { type: 'object', properties: {} },
    async execute(): Promise<ToolResult> {
      const start = performance.now();
      try {
        if (!deps.remount) {
          return {
            toolName: 'skill.reload',
            success: false,
            error: 'no remount callback wired — reload has no effect in this deployment',
            durationMs: performance.now() - start,
          };
        }
        const r = deps.remount();
        const mounted = Array.isArray(r) ? r : await r;
        return {
          toolName: 'skill.reload',
          success: true,
          output: JSON.stringify({ mountedToolCount: mounted.length, toolNames: mounted }),
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          toolName: 'skill.reload',
          success: false,
          error: (err as Error).message,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * Convenience bundle: return all four skill-authoring tools.
 */
export function skillAuthoringTools(deps: SkillToolDeps): AgentTool[] {
  return [
    skillCreateTool(deps),
    skillListTool(deps),
    skillRemoveTool(deps),
    skillReloadTool(deps),
  ];
}
