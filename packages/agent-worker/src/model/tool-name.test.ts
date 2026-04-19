import { describe, it, expect } from 'vitest';
import { sanitizeToolName, buildToolNameMap } from './tool-name.js';
import type { ToolDefinition } from './types.js';

function td(name: string): ToolDefinition {
  return { name, description: name, inputSchema: { type: 'object' } };
}

describe('sanitizeToolName', () => {
  it('replaces dots with underscores', () => {
    expect(sanitizeToolName('fs.read')).toBe('fs_read');
    expect(sanitizeToolName('skill.create')).toBe('skill_create');
  });

  it('keeps already-compliant names untouched', () => {
    expect(sanitizeToolName('fs_read')).toBe('fs_read');
    expect(sanitizeToolName('bash-run')).toBe('bash-run');
    expect(sanitizeToolName('ToolName123')).toBe('ToolName123');
  });

  it('replaces other non-allowed punctuation', () => {
    expect(sanitizeToolName('ns:tool')).toBe('ns_tool');
    expect(sanitizeToolName('a/b')).toBe('a_b');
  });
});

describe('buildToolNameMap', () => {
  it('rewrites wire names and preserves canonical mapping', () => {
    const { wireTools, wireToCanonical } = buildToolNameMap([
      td('fs.read'),
      td('skill.create'),
      td('bash-run'),
    ]);
    expect(wireTools.map((t) => t.name)).toEqual(['fs_read', 'skill_create', 'bash-run']);
    expect(wireToCanonical.get('fs_read')).toBe('fs.read');
    expect(wireToCanonical.get('skill_create')).toBe('skill.create');
    expect(wireToCanonical.get('bash-run')).toBe('bash-run');
  });

  it('throws on collisions between canonical names', () => {
    // both normalize to "a_b" — must throw.
    expect(() => buildToolNameMap([td('a.b'), td('a_b')])).toThrow(/collision/);
  });

  it('allows duplicate entries for the same canonical name (no-op)', () => {
    // Shouldn't throw — re-registering the same canonical name is fine.
    const { wireToCanonical } = buildToolNameMap([td('fs.read'), td('fs.read')]);
    expect(wireToCanonical.size).toBe(1);
    expect(wireToCanonical.get('fs_read')).toBe('fs.read');
  });
});
