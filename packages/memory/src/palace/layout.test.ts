import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ensurePalaceLayout, layoutFor, isWing, WINGS, wingFile } from './layout.js';

describe('palace layout', () => {
  it('WINGS has the four documented wings', () => {
    expect([...WINGS].sort()).toEqual(['interactions', 'knowledge', 'personal', 'work']);
  });

  it('isWing narrows unknown strings', () => {
    expect(isWing('work')).toBe(true);
    expect(isWing('random')).toBe(false);
  });

  it('layoutFor resolves paths under root', () => {
    const layout = layoutFor('/tmp/palace-test');
    expect(layout.dbPath).toMatch(/palace\.db$/);
    expect(layout.wingsRoot).toContain('wings');
  });

  it('ensurePalaceLayout creates all wings and dirs', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'palace-'));
    try {
      const layout = layoutFor(dir);
      await ensurePalaceLayout(layout);
      expect(statSync(layout.wingsRoot).isDirectory()).toBe(true);
      expect(statSync(layout.dailyRoot).isDirectory()).toBe(true);
      expect(statSync(layout.archiveRoot).isDirectory()).toBe(true);
      for (const wing of WINGS) {
        expect(statSync(`${layout.wingsRoot}/${wing}`).isDirectory()).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('wingFile produces a file path inside the wing', () => {
    const layout = layoutFor('/tmp/palace-test');
    const path = wingFile(layout, 'work', 'projects.md');
    expect(path).toContain('wings');
    expect(path).toContain('work');
    expect(path.endsWith('projects.md')).toBe(true);
  });
});
