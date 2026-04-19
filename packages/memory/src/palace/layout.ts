import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * Palace wings — top-level memory domains. Keep this enum load-bearing: the
 * ingest classifier and search boost logic both key off it.
 */
export const WINGS = ['personal', 'work', 'knowledge', 'interactions'] as const;
export type Wing = (typeof WINGS)[number];

export function isWing(value: string): value is Wing {
  return (WINGS as readonly string[]).includes(value);
}

export interface PalaceLayout {
  /**
   * Absolute path to the palace root (e.g. `~/.agent/memory/`).
   */
  root: string;
  dbPath: string;
  wingsRoot: string;
  dailyRoot: string;
  archiveRoot: string;
}

export function expandHome(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

export function layoutFor(root: string): PalaceLayout {
  const base = expandHome(root);
  return {
    root: base,
    dbPath: resolve(base, 'palace.db'),
    wingsRoot: resolve(base, 'wings'),
    dailyRoot: resolve(base, 'daily'),
    archiveRoot: resolve(base, 'archive'),
  };
}

export function wingDir(layout: PalaceLayout, wing: Wing): string {
  return resolve(layout.wingsRoot, wing);
}

export function wingFile(layout: PalaceLayout, wing: Wing, fileName: string): string {
  return resolve(wingDir(layout, wing), fileName);
}

/**
 * Create all directories under the palace root. Idempotent.
 */
export async function ensurePalaceLayout(layout: PalaceLayout): Promise<void> {
  await mkdir(layout.root, { recursive: true });
  await mkdir(layout.wingsRoot, { recursive: true });
  await mkdir(layout.dailyRoot, { recursive: true });
  await mkdir(layout.archiveRoot, { recursive: true });
  for (const wing of WINGS) {
    await mkdir(wingDir(layout, wing), { recursive: true });
  }
}

export function dailyFile(layout: PalaceLayout, date: Date): string {
  const iso = date.toISOString().slice(0, 10);
  return resolve(layout.dailyRoot, `${iso}.md`);
}
