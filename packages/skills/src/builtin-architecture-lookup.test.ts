import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// The skill source is a plain ESM .js file sitting outside tsc's rootDir so it
// matches the on-disk install layout (~/.agent/skills/<id>/index.js). We
// import it via a runtime URL so TypeScript doesn't need a declaration.
const BUILTIN_DIR = resolve(
  fileURLToPath(new URL('../builtin/architecture-lookup', import.meta.url)),
);
const ENTRY = resolve(BUILTIN_DIR, 'index.js');

interface LoadedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  execute(args: unknown, ctx?: unknown): Promise<{
    toolName: string;
    success: boolean;
    output?: string;
    error?: string;
    durationMs: number;
  }>;
}

interface Factory {
  createTools(ctx: {
    manifest: { id: string; version: string };
    installDir: string;
  }): LoadedTool[];
}

describe('builtin architecture-lookup skill', () => {
  let tools: LoadedTool[];
  let lookup: LoadedTool;
  let search: LoadedTool;

  beforeAll(async () => {
    const mod = (await import(`file://${ENTRY.replace(/\\/g, '/')}`)) as Factory;
    tools = mod.createTools({
      manifest: { id: 'architecture-lookup', version: '0.1.0' },
      installDir: BUILTIN_DIR,
    });
    const byName = new Map(tools.map((t) => [t.name, t]));
    lookup = byName.get('architecture.lookup')!;
    search = byName.get('architecture.search')!;
  });

  it('exposes two tools', () => {
    expect(tools).toHaveLength(2);
    expect(lookup).toBeDefined();
    expect(search).toBeDefined();
  });

  describe('architecture.lookup', () => {
    it('returns a table of contents when called with no args', async () => {
      const res = await lookup.execute({});
      expect(res.success).toBe(true);
      expect(res.output).toContain('Table of contents');
      // visualize_architecture.md has §0 through §14.
      expect(res.output).toContain('§ 0.');
      expect(res.output).toContain('§ 6.');
      expect(res.output).toContain('§13.');
    });

    it('returns the requested section by number', async () => {
      const res = await lookup.execute({ section: '6' });
      expect(res.success).toBe(true);
      expect(res.output ?? '').toMatch(/^## 6\. /m);
      // Should not leak §7 content.
      expect(res.output ?? '').not.toMatch(/^## 7\. /m);
    });

    it('returns the section matched by a title keyword', async () => {
      const res = await lookup.execute({ section: 'EGO' });
      expect(res.success).toBe(true);
      // §6 in visualize_architecture.md is titled "[E1] EGO 레이어 …".
      expect(res.output ?? '').toMatch(/^## 6\. /m);
    });

    it('returns the section via block id (E1)', async () => {
      const res = await lookup.execute({ section: 'E1' });
      expect(res.success).toBe(true);
      expect(res.output ?? '').toMatch(/^## 6\. /m);
    });

    it('reports failure with a hint on unknown section', async () => {
      const res = await lookup.execute({ section: 'zzz-no-such-thing' });
      expect(res.success).toBe(false);
      expect(res.error ?? '').toContain('no section matches');
      expect(res.error ?? '').toContain('table of contents');
    });
  });

  describe('architecture.search', () => {
    it('finds a unique technical term with a snippet', async () => {
      const res = await search.execute({ query: 'ComplexityRouter' });
      expect(res.success).toBe(true);
      expect(res.output ?? '').toContain('ComplexityRouter');
      // Ranked output prefixes each hit with "§N".
      expect(res.output ?? '').toMatch(/§\d+ /);
    });

    it('returns "no matches" for a query that is not present', async () => {
      const res = await search.execute({ query: 'ZZZZZ-no-match-ZZZZZ' });
      expect(res.success).toBe(true);
      expect(res.output ?? '').toMatch(/no matches/);
    });

    it('rejects empty query', async () => {
      const res = await search.execute({ query: '' });
      expect(res.success).toBe(false);
      expect(res.error ?? '').toContain('non-empty');
    });

    it('escapes regex metacharacters in the query', async () => {
      // A dot in the query must be treated as a literal character, not wildcard.
      // `chat.delta` is a literal substring inside the Gateway walkthrough.
      const res = await search.execute({ query: 'chat.delta' });
      expect(res.success).toBe(true);
      expect(res.output ?? '').toContain('chat.delta');
    });
  });
});
