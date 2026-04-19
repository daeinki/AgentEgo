// architecture-lookup (first-party builtin skill)
//
// Exposes two tools that let the agent consult the TUI → Gateway → Control
// Plane → EGO → AgentRunner → Reasoner flow described in
// `visualize_architecture.md`:
//
//   - architecture.lookup({ section? }) — TOC (no args) or section body.
//   - architecture.search({ query, maxResults? }) — substring search across
//     sections, returning ranked snippets.
//
// The skill is pure read-only: no shell, no network, no filesystem access
// beyond the single bundled doc file inside its own install directory.
//
// Loaded by `loadSkillTools()` via a dynamic ESM import. Written as plain
// `.js` to match the on-disk install layout (~/.agent/skills/<id>/index.js)
// expected by the existing skill loader — same pattern agent-authored
// skills use.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DOC_FILE = 'visualize_architecture.md';
const MAX_OUTPUT_CHARS = 8000;

export function createTools(ctx) {
  const docPath = resolve(ctx.installDir, DOC_FILE);
  let cached;
  const load = () => {
    if (!cached) {
      const raw = readFileSync(docPath, 'utf-8');
      cached = buildIndex(raw);
    }
    return cached;
  };

  return [
    {
      name: 'architecture.lookup',
      description:
        'Look up a section of the agent-platform architecture walkthrough ' +
        '(TUI → Gateway → Control Plane → EGO → AgentRunner → Reasoner). ' +
        'Omit `section` for the table of contents.',
      permissions: [],
      riskLevel: 'low',
      inputSchema: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            description:
              'Section number (e.g. "6"), block id (e.g. "E1", "R1a"), or a ' +
              'keyword from the section heading (e.g. "EGO", "Reasoning"). ' +
              'Omit to return the table of contents.',
          },
        },
      },
      async execute(args) {
        const start = Date.now();
        const { section } = normalizeLookupArgs(args);
        const index = load();
        if (!section) {
          return {
            toolName: 'architecture.lookup',
            success: true,
            output: renderToc(index),
            durationMs: Date.now() - start,
          };
        }
        const found = findSection(index, section);
        if (!found) {
          return {
            toolName: 'architecture.lookup',
            success: false,
            error:
              `no section matches '${section}'. ` +
              `Try architecture.lookup() to see the table of contents.`,
            durationMs: Date.now() - start,
          };
        }
        let body = index.byNumber.get(found.num) ?? '';
        if (body.length > MAX_OUTPUT_CHARS) {
          body = body.slice(0, MAX_OUTPUT_CHARS) + '\n\n…[truncated]';
        }
        const hint =
          found.alternates.length > 0
            ? `\n\n_Other matches: §${found.alternates.join(', §')}_`
            : '';
        return {
          toolName: 'architecture.lookup',
          success: true,
          output: body + hint,
          durationMs: Date.now() - start,
        };
      },
    },
    {
      name: 'architecture.search',
      description:
        'Search the architecture walkthrough for a keyword and return the ' +
        'top-ranked sections with short snippets.',
      permissions: [],
      riskLevel: 'low',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: {
            type: 'string',
            description: 'Keyword or short phrase. Case-insensitive.',
          },
          maxResults: {
            type: 'integer',
            minimum: 1,
            maximum: 10,
            default: 5,
            description: 'Maximum number of matching sections to return.',
          },
        },
      },
      async execute(args) {
        const start = Date.now();
        const { query, maxResults } = normalizeSearchArgs(args);
        if (!query) {
          return {
            toolName: 'architecture.search',
            success: false,
            error: 'query must be a non-empty string',
            durationMs: Date.now() - start,
          };
        }
        const index = load();
        const results = searchSections(index, query, maxResults);
        if (results.length === 0) {
          return {
            toolName: 'architecture.search',
            success: true,
            output: `no matches for '${query}'`,
            durationMs: Date.now() - start,
          };
        }
        const rendered = results
          .map(
            (r) =>
              `§${r.num} ${r.title} — ${r.hits} hit${r.hits === 1 ? '' : 's'}\n` +
              `  ${r.snippet.replace(/\s+/g, ' ').trim()}`,
          )
          .join('\n\n');
        return {
          toolName: 'architecture.search',
          success: true,
          output: rendered,
          durationMs: Date.now() - start,
        };
      },
    },
  ];
}

// ─── Index construction ────────────────────────────────────────────────────

function buildIndex(raw) {
  const lines = raw.split('\n');
  const toc = [];
  const sectionStarts = [];
  const blockIndex = new Map();

  // Match top-level "## N. Title" headings (skip fenced code blocks).
  let inFence = false;
  let currentNum;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const topMatch = /^## (\d+)\. (.+)$/.exec(line);
    if (topMatch) {
      const num = Number.parseInt(topMatch[1], 10);
      const title = topMatch[2].trim();
      sectionStarts.push({ num, title, lineStart: i });
      toc.push({ num, title, lineStart: i });
      currentNum = num;
      continue;
    }
    // Block subheadings like `### [E1] EgoLayer` or `### [R1a] …`
    if (currentNum !== undefined) {
      const blockMatch = /^###\s+\[([A-Z]\d+[a-z]?)\]/.exec(line);
      if (blockMatch && !blockIndex.has(blockMatch[1])) {
        blockIndex.set(blockMatch[1], currentNum);
      }
    }
  }

  const byNumber = new Map();
  for (let i = 0; i < sectionStarts.length; i++) {
    const start = sectionStarts[i];
    const nextStart = sectionStarts[i + 1]?.lineStart ?? lines.length;
    const body = lines.slice(start.lineStart, nextStart).join('\n').replace(/\s+$/s, '');
    byNumber.set(start.num, body);
  }

  const titleIndex = toc.map((s) => ({ keyword: s.title.toLowerCase(), num: s.num }));
  return { raw, toc, byNumber, titleIndex, blockIndex };
}

// ─── Lookup ────────────────────────────────────────────────────────────────

function findSection(index, query) {
  const q = query.trim();
  if (q.length === 0) return undefined;

  // 1. Pure number: "6"
  if (/^\d+$/.test(q)) {
    const num = Number.parseInt(q, 10);
    if (index.byNumber.has(num)) return { num, alternates: [] };
  }

  // 2. Block id: "E1", "R1a", "[G3]"
  const blockMatch = /^\[?([A-Z]\d+[a-z]?)\]?$/.exec(q);
  if (blockMatch) {
    const key = blockMatch[1];
    const num = index.blockIndex.get(key);
    if (num !== undefined) return { num, alternates: [] };
  }

  // 3. Keyword in title, case-insensitive substring.
  const ql = q.toLowerCase();
  const titleHits = index.titleIndex.filter((t) => t.keyword.includes(ql));
  if (titleHits.length > 0) {
    const [first, ...rest] = titleHits;
    return { num: first.num, alternates: rest.map((r) => r.num) };
  }

  return undefined;
}

// ─── Search ────────────────────────────────────────────────────────────────

function searchSections(index, query, maxResults) {
  const pattern = new RegExp(escapeRegex(query), 'gi');
  const results = [];
  for (const entry of index.toc) {
    const body = index.byNumber.get(entry.num) ?? '';
    const matches = body.match(pattern);
    if (!matches) continue;
    const firstIdx = body.search(pattern);
    const snippet = extractSnippet(body, firstIdx, query.length);
    results.push({ num: entry.num, title: entry.title, hits: matches.length, snippet });
  }
  results.sort((a, b) => b.hits - a.hits || a.num - b.num);
  return results.slice(0, maxResults);
}

function extractSnippet(body, matchStart, matchLen) {
  const before = Math.max(0, matchStart - 80);
  const after = Math.min(body.length, matchStart + matchLen + 80);
  const prefix = before > 0 ? '…' : '';
  const suffix = after < body.length ? '…' : '';
  return prefix + body.slice(before, after) + suffix;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Rendering ─────────────────────────────────────────────────────────────

function renderToc(index) {
  const head = 'Table of contents — `visualize_architecture.md`\n';
  const body = index.toc
    .map((s) => `  §${String(s.num).padStart(2, ' ')}. ${s.title}`)
    .join('\n');
  const blocks =
    index.blockIndex.size > 0
      ? `\n\nBlock index (→ section):\n` +
        [...index.blockIndex.entries()]
          .map(([k, v]) => `  [${k}] → §${v}`)
          .join('\n')
      : '';
  return head + body + blocks;
}

// ─── Arg normalization ─────────────────────────────────────────────────────

function normalizeLookupArgs(args) {
  if (args === null || args === undefined) return {};
  if (typeof args !== 'object') return {};
  const section = args.section;
  if (typeof section === 'string' && section.trim().length > 0) {
    return { section: section.trim() };
  }
  return {};
}

function normalizeSearchArgs(args) {
  const defaults = { query: '', maxResults: 5 };
  if (args === null || args === undefined || typeof args !== 'object') return defaults;
  const q = typeof args.query === 'string' ? args.query.trim() : '';
  let n = typeof args.maxResults === 'number' ? args.maxResults : 5;
  if (!Number.isFinite(n)) n = 5;
  n = Math.max(1, Math.min(10, Math.floor(n)));
  return { query: q, maxResults: n };
}
