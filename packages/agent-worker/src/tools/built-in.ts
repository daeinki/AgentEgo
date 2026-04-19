import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { ToolResult } from '@agent-platform/core';
import type { AgentTool } from './types.js';

interface FsReadArgs {
  path: string;
  maxBytes?: number;
}

/**
 * fs.read — read a UTF-8 file. Argument path must be inside `allowedRoots`.
 */
export function fsReadTool(allowedRoots: string[]): AgentTool<FsReadArgs> {
  const resolvedRoots = allowedRoots.map((r) => resolve(r));
  return {
    name: 'fs.read',
    description: 'Read a UTF-8 text file from an allowlisted directory.',
    riskLevel: 'low',
    permissions: [{ type: 'filesystem', access: 'read', paths: resolvedRoots }],
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Absolute file path.' },
        maxBytes: { type: 'integer', minimum: 1, default: 1_048_576 },
      },
    },
    async execute(args): Promise<ToolResult> {
      const start = performance.now();
      const full = isAbsolute(args.path) ? args.path : resolve(args.path);
      if (!resolvedRoots.some((r) => isInside(full, r))) {
        return {
          toolName: 'fs.read',
          success: false,
          error: `path outside allow-list: ${full}`,
          durationMs: performance.now() - start,
        };
      }
      try {
        const content = await readFile(full, 'utf-8');
        const cap = args.maxBytes ?? 1_048_576;
        const output = content.length > cap ? content.slice(0, cap) : content;
        return {
          toolName: 'fs.read',
          success: true,
          output,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          toolName: 'fs.read',
          success: false,
          error: (err as Error).message,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

interface FsListArgs {
  path: string;
  maxEntries?: number;
}

/**
 * fs.list — enumerate immediate children of a directory. Returns one entry
 * per line in the form `"<file|dir>  <name>"`. Argument path must be inside
 * `allowedRoots` (same allowlist semantics as fs.read).
 */
export function fsListTool(allowedRoots: string[]): AgentTool<FsListArgs> {
  const resolvedRoots = allowedRoots.map((r) => resolve(r));
  return {
    name: 'fs.list',
    description:
      'List the immediate entries (files and subdirectories) of a directory. ' +
      'Use this for "show files in X" / "현재 디렉토리 파일 목록" style requests. ' +
      'The path may be absolute or relative to the gateway CWD; both must resolve inside the allow-list.',
    riskLevel: 'low',
    permissions: [{ type: 'filesystem', access: 'read', paths: resolvedRoots }],
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: 'Directory path. Use "." for the gateway current working directory.',
        },
        maxEntries: { type: 'integer', minimum: 1, default: 500 },
      },
    },
    async execute(args): Promise<ToolResult> {
      const start = performance.now();
      const full = isAbsolute(args.path) ? args.path : resolve(args.path);
      if (!resolvedRoots.some((r) => isInside(full, r))) {
        return {
          toolName: 'fs.list',
          success: false,
          error: `path outside allow-list: ${full}`,
          durationMs: performance.now() - start,
        };
      }
      try {
        const entries = await readdir(full, { withFileTypes: true });
        const cap = args.maxEntries ?? 500;
        const limited = entries.length > cap ? entries.slice(0, cap) : entries;
        const lines = limited.map((e) => {
          const kind = e.isDirectory() ? 'dir ' : e.isSymbolicLink() ? 'link' : 'file';
          return `${kind}  ${e.name}`;
        });
        const truncatedNote =
          entries.length > cap
            ? `\n... (+${entries.length - cap} more, raise maxEntries to see all)`
            : '';
        return {
          toolName: 'fs.list',
          success: true,
          output: `Listing ${full} (${entries.length} entries)\n${lines.join('\n')}${truncatedNote}`,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          toolName: 'fs.list',
          success: false,
          error: (err as Error).message,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

interface FsWriteArgs {
  path: string;
  content: string;
  createDirs?: boolean;
}

/**
 * fs.write — write a UTF-8 file. Argument path must be inside `allowedRoots`.
 */
export function fsWriteTool(allowedRoots: string[]): AgentTool<FsWriteArgs> {
  const resolvedRoots = allowedRoots.map((r) => resolve(r));
  return {
    name: 'fs.write',
    description: 'Write a UTF-8 text file inside an allowlisted directory.',
    riskLevel: 'medium',
    permissions: [{ type: 'filesystem', access: 'write', paths: resolvedRoots }],
    inputSchema: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        createDirs: { type: 'boolean', default: false },
      },
    },
    async execute(args): Promise<ToolResult> {
      const start = performance.now();
      const full = isAbsolute(args.path) ? args.path : resolve(args.path);
      if (!resolvedRoots.some((r) => isInside(full, r))) {
        return {
          toolName: 'fs.write',
          success: false,
          error: `path outside allow-list: ${full}`,
          durationMs: performance.now() - start,
        };
      }
      try {
        if (args.createDirs) {
          await mkdir(dirname(full), { recursive: true });
        }
        await writeFile(full, args.content, 'utf-8');
        return {
          toolName: 'fs.write',
          success: true,
          output: `wrote ${Buffer.byteLength(args.content, 'utf-8')} bytes to ${full}`,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          toolName: 'fs.write',
          success: false,
          error: (err as Error).message,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

interface WebFetchArgs {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  maxBytes?: number;
}

/**
 * web.fetch — GET/POST against a domain allow-list. Abides by the AbortSignal
 * the sandbox supplies (so the outer timeout applies).
 */
export function webFetchTool(allowedDomains: string[]): AgentTool<WebFetchArgs> {
  return {
    name: 'web.fetch',
    description: 'HTTP fetch against an allowlisted domain.',
    riskLevel: 'medium',
    permissions: [{ type: 'network', access: 'outbound', domains: allowedDomains }],
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', format: 'uri' },
        method: { type: 'string', enum: ['GET', 'POST'], default: 'GET' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: { type: 'string' },
        maxBytes: { type: 'integer', minimum: 1, default: 262_144 },
      },
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = performance.now();
      let url: URL;
      try {
        url = new URL(args.url);
      } catch {
        return {
          toolName: 'web.fetch',
          success: false,
          error: `invalid url: ${args.url}`,
          durationMs: performance.now() - start,
        };
      }
      if (!isDomainAllowed(url.hostname, allowedDomains)) {
        return {
          toolName: 'web.fetch',
          success: false,
          error: `domain not allow-listed: ${url.hostname}`,
          durationMs: performance.now() - start,
        };
      }
      try {
        const init: RequestInit = {
          method: args.method ?? 'GET',
          signal: ctx.signal,
        };
        if (args.headers !== undefined) init.headers = args.headers;
        if (args.body !== undefined) init.body = args.body;
        const response = await fetch(url, init);
        const text = await response.text();
        const cap = args.maxBytes ?? 262_144;
        const output = text.length > cap ? text.slice(0, cap) : text;
        return {
          toolName: 'web.fetch',
          success: response.ok,
          output: `HTTP ${response.status}\n\n${output}`,
          ...(response.ok ? {} : { error: `HTTP ${response.status} ${response.statusText}` }),
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          toolName: 'web.fetch',
          success: false,
          error: (err as Error).message,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function isInside(candidate: string, root: string): boolean {
  const a = candidate.replaceAll('\\', '/');
  const b = root.replaceAll('\\', '/');
  return a === b || a.startsWith(`${b}/`);
}

function isDomainAllowed(host: string, allowed: string[]): boolean {
  for (const pattern of allowed) {
    if (pattern === host) return true;
    // Allow "*.example.com" style wildcards.
    if (pattern.startsWith('*.') && host.endsWith(pattern.slice(1))) return true;
  }
  return false;
}
