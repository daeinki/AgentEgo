import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PalaceMemorySystem } from './palace-memory.js';
import { HashEmbedder } from './embedding/hash-embedder.js';

describe('PalaceMemorySystem', () => {
  let dir: string;
  let mem: PalaceMemorySystem;

  beforeEach(async () => {
    dir = mkdtempSync(resolve(tmpdir(), 'palace-mem-'));
    mem = new PalaceMemorySystem({ root: dir, embedder: new HashEmbedder(128) });
    await mem.init();
  });

  afterEach(async () => {
    await mem.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('init() creates the palace directory tree', () => {
    expect(existsSync(`${dir}/wings/work`)).toBe(true);
    expect(existsSync(`${dir}/wings/knowledge`)).toBe(true);
  });

  it('ingest() writes a wing file and indexes chunks', async () => {
    const result = await mem.ingest({
      sessionId: 'sess-1',
      userMessage: 'TypeScript 배포 파이프라인 설계해줘',
      agentResponse: '먼저 GitHub Actions 워크플로우를 만들고, 배포 단계에서 Docker 이미지를...',
      timestamp: Date.now(),
    });
    expect(result.chunksAdded).toBeGreaterThan(0);
    expect(result.classifications[0]).toMatch(/^work\/|knowledge\//);

    // Wing file should exist and contain the ingested content.
    const counts = mem.countByWing();
    expect(counts.work + counts.knowledge).toBeGreaterThan(0);
  });

  it('classify() returns a ClassificationResult', async () => {
    const res = await mem.classify('PR 배포 진행됨');
    expect(res.wing).toBe('work');
    expect(res.confidence).toBeGreaterThan(0);
  });

  it('search() finds an ingested chunk via BM25 + vector', async () => {
    await mem.ingest({
      sessionId: 'sess-2',
      userMessage: 'TypeScript 배포 파이프라인 설계해줘',
      agentResponse: 'GitHub Actions와 Docker를 써서 프로덕션 배포 자동화를 구성합니다.',
      timestamp: Date.now(),
    });
    const results = await mem.search('TypeScript 배포', {
      sessionId: 'sess-2',
      agentId: 'agent-x',
      recentTopics: [],
      maxResults: 3,
      minRelevanceScore: 0,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.content).toContain('TypeScript');
    expect(results[0]?.relevance.combinedScore).toBeGreaterThan(0);
  });

  it('search() honors preferredWings for structure boost', async () => {
    // Ingest the same phrase twice; one lands in `work`, the other in `knowledge`.
    await mem.ingest({
      sessionId: 's',
      userMessage: '',
      agentResponse: '배포 PR 머지 완료됨 (프로젝트 alpha)',
      timestamp: Date.now(),
    });
    await mem.ingest({
      sessionId: 's',
      userMessage: '',
      agentResponse: 'TypeScript interface는 런타임 비용이 없는 타입 정의입니다.',
      timestamp: Date.now(),
    });
    const withBoost = await mem.search('TypeScript', {
      sessionId: 's',
      agentId: 'a',
      recentTopics: [],
      preferredWings: ['knowledge'],
      maxResults: 5,
      minRelevanceScore: 0,
    });
    expect(withBoost[0]?.source.wing).toBe('knowledge');
  });

  it('compact() archives old chunks and writes a summary', async () => {
    // Ingest, then manually age them in the DB via direct ingest (Date.now is
    // "now", so olderThan in the future should catch everything).
    await mem.ingest({
      sessionId: 's',
      userMessage: '질문 1',
      agentResponse: '답변 1 — 배포 파이프라인 관련',
      timestamp: Date.now(),
    });
    await mem.ingest({
      sessionId: 's',
      userMessage: '질문 2',
      agentResponse: '답변 2 — PR 리뷰 관련',
      timestamp: Date.now(),
    });
    const future = new Date(Date.now() + 60_000);
    const result = await mem.compact('work', future);
    expect(result.archivedChunks).toBeGreaterThan(0);
    expect(result.summaryChunkId).toBeTruthy();
    expect(existsSync(`${dir}/wings/work/compacted.md`)).toBe(true);
    const content = readFileSync(`${dir}/wings/work/compacted.md`, 'utf-8');
    expect(content).toContain('Compacted');
  });

  it('compact() is a no-op when nothing is older than cutoff', async () => {
    const res = await mem.compact('work', new Date(0));
    expect(res.archivedChunks).toBe(0);
  });

  it('throws on search before init', async () => {
    const m2 = new PalaceMemorySystem({ root: dir });
    await expect(
      m2.search('x', {
        sessionId: 's',
        agentId: 'a',
        recentTopics: [],
        maxResults: 1,
        minRelevanceScore: 0,
      }),
    ).rejects.toThrow(/not initialized/);
  });
});
