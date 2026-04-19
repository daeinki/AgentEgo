import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { FilePersonaManager } from './persona-manager.js';
import { intake } from './signal.js';
import { normalize } from './normalize.js';
import type { StandardMessage } from '@agent-platform/core';
import { generateMessageId, generateTraceId, nowMs } from '@agent-platform/core';

function makeSignal(text: string) {
  const msg: StandardMessage = {
    id: generateMessageId(),
    traceId: generateTraceId(),
    timestamp: nowMs(),
    channel: { type: 'webchat', id: 'w-1', metadata: {} },
    sender: { id: 'user-1', isOwner: true },
    conversation: { type: 'dm', id: 'c-1' },
    content: { type: 'text', text },
  };
  return normalize(intake(msg));
}

describe('FilePersonaManager', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'ego-persona-'));
    path = resolve(dir, 'persona.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const cfg = (maxTokens = 250) => ({
    storePath: path,
    snapshot: {
      maxTokens,
      topRelevantBehaviors: 3,
      topRelevantExpertise: 3,
      includeRelationshipContext: true,
    },
  });

  it('creates a default persona on first load', async () => {
    const mgr = new FilePersonaManager(cfg());
    const p = await mgr.load();
    expect(p.personaId).toMatch(/^prs-/);
    expect(p.learnedBehaviors).toEqual([]);
    expect(p.relationshipContext.communicationMaturity).toBe('new');
  });

  it('snapshot includes identity and respects topK for behaviors', async () => {
    const mgr = new FilePersonaManager(cfg());
    const p = await mgr.load();
    p.learnedBehaviors = [
      {
        trigger: '코드 리뷰 요청',
        learned: '보안 먼저',
        confidence: 0.9,
        source: 'correction',
        learnedAt: new Date().toISOString(),
      },
      {
        trigger: '아침 인사',
        learned: '일정 요약',
        confidence: 0.7,
        source: 'positive-feedback',
        learnedAt: new Date().toISOString(),
      },
    ];
    p.domainExpertise = [
      {
        domain: 'software-engineering',
        confidence: 0.8,
        subTopics: ['typescript'],
        learnedFrom: 100,
        lastActive: new Date().toISOString(),
      },
    ];

    const s = await mgr.snapshot(makeSignal('TypeScript 코드 리뷰해줘'));
    expect(s.summary).toContain('이름');
    expect(s.relevantBehaviors.length).toBeLessThanOrEqual(3);
    expect(s.relevantExpertise.length).toBeLessThanOrEqual(3);
    expect(s.estimatedTokens).toBeGreaterThan(0);
    expect(s.estimatedTokens).toBeLessThanOrEqual(250);
  });

  it('truncates when maxTokens is small', async () => {
    const mgr = new FilePersonaManager(cfg(40));
    const p = await mgr.load();
    p.learnedBehaviors = Array.from({ length: 5 }, (_, i) => ({
      trigger: `trigger-${i}`,
      learned: 'learned behavior text here padding padding padding',
      confidence: 0.5,
      source: 'implicit' as const,
      learnedAt: new Date().toISOString(),
    }));
    const s = await mgr.snapshot(makeSignal('hi'));
    expect(s.estimatedTokens).toBeLessThanOrEqual(60);
    expect(mgr.wasSnapshotTruncated()).toBe(true);
  });

  it('exports with checksum', async () => {
    const mgr = new FilePersonaManager(cfg());
    await mgr.load();
    const ex = await mgr.export();
    expect(ex.format).toBe('ego-persona-v1');
    expect(ex.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('import resets relationshipContext to new', async () => {
    const mgr = new FilePersonaManager(cfg());
    const p = await mgr.load();
    p.relationshipContext.trustLevel = 0.99;
    p.relationshipContext.communicationMaturity = 'established';
    const ex = await mgr.export();
    ex.persona = p;

    const other = new FilePersonaManager({
      ...cfg(),
      storePath: resolve(dir, 'other.json'),
    });
    await other.import(ex);
    const imported = await other.load();
    expect(imported.relationshipContext.trustLevel).toBe(0.5);
    expect(imported.relationshipContext.communicationMaturity).toBe('new');
  });
});
