import { describe, it, expect } from 'vitest';
import { LiveToolRegistry } from './live-registry.js';
import type { AgentTool } from './types.js';

function tool(name: string): AgentTool {
  return {
    name,
    description: `tool ${name}`,
    permissions: [],
    riskLevel: 'low',
    inputSchema: { type: 'object' },
    async execute() {
      return { toolName: name, success: true, output: '', durationMs: 0 };
    },
  };
}

describe('LiveToolRegistry (U10 Phase 4.1)', () => {
  it('starts from initial and exposes descriptors()', () => {
    const r = new LiveToolRegistry([tool('fs.read'), tool('web.fetch')]);
    expect(r.size).toBe(2);
    const descNames = r.descriptors().map((d) => d.name);
    expect(descNames).toEqual(expect.arrayContaining(['fs.read', 'web.fetch']));
  });

  it('asMap() returns a live reference — mutations visible to holders', () => {
    const r = new LiveToolRegistry();
    const m = r.asMap();
    expect(m.size).toBe(0);
    r.register(tool('time.now'));
    // The externally-captured Map must now reflect the new entry.
    expect(m.has('time.now')).toBe(true);
  });

  it('registerAll overrides on name conflict (last wins)', () => {
    const r = new LiveToolRegistry([tool('a')]);
    const override = { ...tool('a'), description: 'override' };
    r.registerAll([override]);
    expect(r.get('a')?.description).toBe('override');
  });

  it('unregister returns true only when a prior entry existed', () => {
    const r = new LiveToolRegistry([tool('a')]);
    expect(r.unregister('a')).toBe(true);
    expect(r.unregister('a')).toBe(false);
  });

  it('replace with preserveNames keeps listed tools and swaps the rest', () => {
    const r = new LiveToolRegistry([tool('keep'), tool('drop')]);
    r.replace([tool('fresh')], new Set(['keep']));
    const names = r.snapshot().map((t) => t.name).sort();
    expect(names).toEqual(['fresh', 'keep']);
  });
});
