import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * Compute a deterministic SHA-256 hash of all files in a directory, ignoring
 * `manifest.json` itself (the manifest is what stores the hash, so including
 * it would be chicken-and-egg).
 *
 * The hashing strategy:
 *   sorted list of "<posix-relative-path>\n<file-sha256>\n" lines,
 *   fed into a final sha256.
 *
 * This is order-stable across filesystems and resilient to the traversal
 * order differences between OSes.
 */
export async function hashSkillDirectory(root: string, excludeFile = 'manifest.json'): Promise<string> {
  const entries = await walkFiles(root);
  const normalized: Array<{ path: string; sha: string }> = [];
  for (const file of entries) {
    const rel = relative(root, file).split(sep).join('/');
    if (rel === excludeFile) continue;
    const bytes = await readFile(file);
    normalized.push({ path: rel, sha: createHash('sha256').update(bytes).digest('hex') });
  }
  normalized.sort((a, b) => a.path.localeCompare(b.path));

  const top = createHash('sha256');
  for (const { path, sha } of normalized) {
    top.update(`${path}\n${sha}\n`);
  }
  return top.digest('hex');
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}
