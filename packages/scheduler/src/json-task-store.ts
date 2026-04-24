import { readFileSync } from 'node:fs';
import type { CronTask, CronTaskType } from './types.js';

/**
 * Load cron task definitions from a JSON file. Returns `[]` when the file
 * does not exist so a missing `tasks.json` is indistinguishable from an
 * empty-but-present one (the platform boots with no scheduled work either way).
 *
 * The file is treated as JSON5 in a restricted sense: line comments (`//`),
 * block comments (`/* *\/`), and trailing commas are stripped before parsing.
 * This matches the convention used elsewhere in the repo's documentation
 * snippets so hand-edited `tasks.json` can carry inline notes.
 */
export function loadTasksFromFile(filePath: string): CronTask[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const stripped = stripJson5(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    throw new Error(`[scheduler] tasks file is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('[scheduler] tasks file must be a top-level array');
  }
  const tasks: CronTask[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < parsed.length; i++) {
    const validated = validateTask(parsed[i], i);
    if (seenIds.has(validated.id)) {
      throw new Error(`[scheduler] duplicate task id: ${validated.id}`);
    }
    seenIds.add(validated.id);
    tasks.push(validated);
  }
  return tasks;
}

/**
 * Exposed for tests that want to exercise the parser without touching the FS.
 */
export function parseTasksJson(text: string): CronTask[] {
  const stripped = stripJson5(text);
  const parsed = JSON.parse(stripped) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('[scheduler] tasks file must be a top-level array');
  }
  const tasks: CronTask[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < parsed.length; i++) {
    const validated = validateTask(parsed[i], i);
    if (seenIds.has(validated.id)) {
      throw new Error(`[scheduler] duplicate task id: ${validated.id}`);
    }
    seenIds.add(validated.id);
    tasks.push(validated);
  }
  return tasks;
}

// ─── Internals ─────────────────────────────────────────────────────────────

function validateTask(raw: unknown, index: number): CronTask {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`[scheduler] task[${index}] must be an object`);
  }
  const r = raw as Record<string, unknown>;

  const id = requireString(r['id'], `task[${index}].id`);
  const spec = requireString(r['spec'], `task[${id}].spec`);
  const enabled =
    r['enabled'] === undefined || r['enabled'] === null ? true : toBool(r['enabled'], `task[${id}].enabled`);
  const description = optionalString(r['description'], `task[${id}].description`);
  const type = requireString(r['type'], `task[${id}].type`) as CronTaskType;

  const base = {
    id,
    spec,
    enabled,
    ...(description !== undefined ? { description } : {}),
  };

  switch (type) {
    case 'chat': {
      const cfg = requireObject(r['chat'], `task[${id}].chat`);
      const prompt = requireString(cfg['prompt'], `task[${id}].chat.prompt`);
      const agentId = optionalString(cfg['agentId'], `task[${id}].chat.agentId`);
      const sessionId = optionalString(cfg['sessionId'], `task[${id}].chat.sessionId`);
      const senderId = optionalString(cfg['senderId'], `task[${id}].chat.senderId`);
      const strategyRaw = optionalString(cfg['sessionStrategy'], `task[${id}].chat.sessionStrategy`);
      if (strategyRaw !== undefined && strategyRaw !== 'pinned' && strategyRaw !== 'fresh') {
        throw new Error(`[scheduler] task[${id}].chat.sessionStrategy must be 'pinned' | 'fresh'`);
      }
      return {
        ...base,
        type: 'chat',
        chat: {
          prompt,
          ...(agentId !== undefined ? { agentId } : {}),
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(senderId !== undefined ? { senderId } : {}),
          ...(strategyRaw !== undefined ? { sessionStrategy: strategyRaw } : {}),
        },
      };
    }
    case 'bash': {
      const cfg = requireObject(r['bash'], `task[${id}].bash`);
      const command = requireString(cfg['command'], `task[${id}].bash.command`);
      const cwd = optionalString(cfg['cwd'], `task[${id}].bash.cwd`);
      const timeoutMs = optionalNumber(cfg['timeoutMs'], `task[${id}].bash.timeoutMs`);
      return {
        ...base,
        type: 'bash',
        bash: {
          command,
          ...(cwd !== undefined ? { cwd } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        },
      };
    }
    case 'workflow': {
      const cfg = requireObject(r['workflow'], `task[${id}].workflow`);
      const path = requireString(cfg['path'], `task[${id}].workflow.path`);
      const initialVarsRaw = cfg['initialVars'];
      const initialVars =
        initialVarsRaw === undefined || initialVarsRaw === null
          ? undefined
          : requireObject(initialVarsRaw, `task[${id}].workflow.initialVars`);
      return {
        ...base,
        type: 'workflow',
        workflow: {
          path,
          ...(initialVars !== undefined ? { initialVars } : {}),
        },
      };
    }
    default:
      throw new Error(`[scheduler] task[${id}].type must be 'chat' | 'bash' | 'workflow' (got ${type})`);
  }
}

function requireString(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`[scheduler] ${where} must be a non-empty string`);
  }
  return v;
}

function optionalString(v: unknown, where: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`[scheduler] ${where} must be a string`);
  return v;
}

function optionalNumber(v: unknown, where: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`[scheduler] ${where} must be a finite number`);
  }
  return v;
}

function requireObject(v: unknown, where: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`[scheduler] ${where} must be an object`);
  }
  return v as Record<string, unknown>;
}

function toBool(v: unknown, where: string): boolean {
  if (typeof v === 'boolean') return v;
  throw new Error(`[scheduler] ${where} must be boolean`);
}

/**
 * Strip `//` line comments, `/* *\/` block comments, and trailing commas.
 * Respects string literals so comment-like sequences inside quoted values are
 * untouched.
 */
export function stripJson5(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    // Strings — copy verbatim until matching quote.
    if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        const ch = text[i]!;
        out += ch;
        if (ch === '\\' && i + 1 < n) {
          out += text[i + 1]!;
          i += 2;
          continue;
        }
        i++;
        if (ch === quote) break;
      }
      continue;
    }
    // Line comment.
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    // Block comment.
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  // Trailing commas before } or ].
  return out.replace(/,(\s*[}\]])/g, '$1');
}
