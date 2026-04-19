import { describe, it, expect } from 'vitest';
import { buildDefaultTools } from './presets.js';

describe('buildDefaultTools', () => {
  it('returns an empty list when no options are provided', () => {
    expect(buildDefaultTools({})).toEqual([]);
  });

  it('includes fs.read + fs.list only when fsRead has at least one root', () => {
    expect(buildDefaultTools({ fsRead: [] })).toEqual([]);
    const tools = buildDefaultTools({ fsRead: ['/tmp'] });
    // fs.list shares fs.read roots — both land together.
    expect(tools.map((t) => t.name)).toEqual(['fs.read', 'fs.list']);
  });

  it('combines fs.read/fs.list + fs.write + web.fetch in stable order', () => {
    const tools = buildDefaultTools({
      fsRead: ['/tmp/r'],
      fsWrite: ['/tmp/w'],
      webFetch: ['example.com'],
    });
    expect(tools.map((t) => t.name)).toEqual(['fs.read', 'fs.list', 'fs.write', 'web.fetch']);
  });

  it('skipped categories do not leak into the output even if other categories are set', () => {
    const tools = buildDefaultTools({ fsRead: ['/tmp'], webFetch: [] });
    expect(tools.map((t) => t.name)).toEqual(['fs.read', 'fs.list']);
  });
});
