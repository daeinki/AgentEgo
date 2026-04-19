import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type {
  Contracts,
  EvolutionRules,
  Persona,
  PersonaFeedback,
  PersonaSnapshot,
} from '@agent-platform/core';
import { generatePersonaId, nowIso } from '@agent-platform/core';
import type { NormalizedSignal } from './normalize.js';
import { applyDecay, evolvePersona, type EvolutionOutcome } from './persona-evolution.js';

type PersonaManager = Contracts.PersonaManager;
type EvolutionResult = Contracts.EvolutionResult;
type PersonaExport = Contracts.PersonaExport;

export interface PersonaManagerConfig {
  storePath: string;
  snapshot: {
    maxTokens: number;
    topRelevantBehaviors: number;
    topRelevantExpertise: number;
    includeRelationshipContext: boolean;
  };
  /**
   * Override evolution rule parameters (§4.2). Any omitted fields fall back
   * to the defaults documented in ego-persona.md §4.2.
   */
  evolutionRules?: Partial<EvolutionRules>;
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

function defaultPersona(): Persona {
  const now = nowIso();
  return {
    version: '1.0.0',
    personaId: generatePersonaId(),
    createdAt: now,
    updatedAt: now,
    totalInteractions: 0,
    evolutionCount: 0,
    identity: {
      name: 'Agent',
      role: '개인 AI 어시스턴트',
      coreDirective: '사용자를 돕는다',
    },
    communicationStyle: {
      formality: 0.4,
      verbosity: 0.4,
      humor: 0.5,
      empathy: 0.6,
      directness: 0.6,
      proactivity: 0.4,
      preferredLanguage: 'ko',
      adaptToUser: true,
    },
    emotionalTendencies: {
      defaultMood: 'calm-neutral',
      sensitivityToFrustration: 0.6,
      celebrationLevel: 0.5,
      cautiousness: 0.5,
      curiosity: 0.6,
      patience: 0.8,
    },
    valuePriorities: {
      accuracy: 0.8,
      speed: 0.6,
      privacy: 0.7,
      creativity: 0.5,
      costEfficiency: 0.7,
      safety: 0.8,
      autonomy: 0.4,
    },
    domainExpertise: [],
    learnedBehaviors: [],
    relationshipContext: {
      interactionStartDate: now,
      trustLevel: 0.5,
      communicationMaturity: 'new',
      knownPreferences: [],
      knownDislikes: [],
      insideJokes: [],
      milestones: [],
    },
    evolutionLog: [],
  };
}

/**
 * Token estimator matching core/normalize/complexity estimation rule.
 */
function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g) ?? []).length;
  return words + Math.ceil(cjk / 2);
}

function truncateToBudget(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  // Remove lines from the bottom (dynamic section first) until under budget.
  const lines = text.split('\n');
  while (lines.length > 4 && estimateTokens(lines.join('\n')) > maxTokens) {
    lines.pop();
  }
  return lines.join('\n');
}

function scoreBehavior(
  b: Persona['learnedBehaviors'][number],
  signal: NormalizedSignal,
): number {
  const haystack = `${b.trigger} ${b.learned}`.toLowerCase();
  let overlap = 0;
  for (const entity of signal.entities) {
    if (haystack.includes(entity.value.toLowerCase())) overlap += 1;
  }
  for (const token of signal.rawText.toLowerCase().split(/\s+/)) {
    if (token.length >= 3 && haystack.includes(token)) overlap += 0.3;
  }
  const ageDays = Math.max(0, (Date.now() - new Date(b.learnedAt).getTime()) / 86_400_000);
  const recency = 1 / (1 + ageDays / 30);
  return overlap * 0.7 + b.confidence * 0.2 + recency * 0.1;
}

function scoreExpertise(
  e: Persona['domainExpertise'][number],
  signal: NormalizedSignal,
): number {
  const haystack = [e.domain, ...e.subTopics].join(' ').toLowerCase();
  let overlap = 0;
  for (const entity of signal.entities) {
    if (haystack.includes(entity.value.toLowerCase())) overlap += 1;
  }
  for (const token of signal.rawText.toLowerCase().split(/\s+/)) {
    if (token.length >= 3 && haystack.includes(token)) overlap += 0.3;
  }
  return overlap * 0.7 + e.confidence * 0.3;
}

/**
 * File-backed PersonaManager. Evolution is a no-op placeholder for Phase PERSONA-1;
 * real evolution logic lands in PERSONA-2 (§4).
 */
export class FilePersonaManager implements PersonaManager {
  private readonly path: string;
  private readonly config: PersonaManagerConfig;
  private cached: Persona | null = null;
  private snapshotTruncatedLastCall = false;

  constructor(config: PersonaManagerConfig) {
    this.config = config;
    this.path = expandHome(config.storePath);
  }

  wasSnapshotTruncated(): boolean {
    return this.snapshotTruncatedLastCall;
  }

  async load(): Promise<Persona> {
    if (this.cached) return this.cached;
    try {
      const raw = await readFile(this.path, 'utf-8');
      this.cached = JSON.parse(raw) as Persona;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cached = defaultPersona();
        await this.persist();
      } else {
        throw err;
      }
    }
    return this.cached!;
  }

  async snapshot(signal: NormalizedSignal): Promise<PersonaSnapshot> {
    const p = await this.load();
    const topBehaviors = p.learnedBehaviors
      .map((b) => ({ item: b, score: scoreBehavior(b, signal) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.snapshot.topRelevantBehaviors);

    const topExpertise = p.domainExpertise
      .map((e) => ({ item: e, score: scoreExpertise(e, signal) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.snapshot.topRelevantExpertise);

    const rel = p.relationshipContext;
    const lines: string[] = [
      `- 이름: ${p.identity.name}. ${p.identity.role}.`,
      `- 말투 formality=${p.communicationStyle.formality}, verbosity=${p.communicationStyle.verbosity}, directness=${p.communicationStyle.directness}, empathy=${p.communicationStyle.empathy}.`,
      `- 기본 언어: ${p.communicationStyle.preferredLanguage}.`,
      `- 핵심 가치: accuracy=${p.valuePriorities.accuracy}, safety=${p.valuePriorities.safety}, autonomy=${p.valuePriorities.autonomy}.`,
    ];

    if (this.config.snapshot.includeRelationshipContext) {
      lines.push(
        `- 관계: ${rel.communicationMaturity}, trustLevel=${rel.trustLevel}.`,
      );
      if (rel.knownPreferences.length) {
        lines.push(`- 선호: ${rel.knownPreferences.slice(0, 3).join(', ')}.`);
      }
      if (rel.knownDislikes.length) {
        lines.push(`- 비선호: ${rel.knownDislikes.slice(0, 3).join(', ')}.`);
      }
    }

    if (topBehaviors.length) {
      lines.push('- 관련 행동 패턴:');
      for (const { item } of topBehaviors) {
        lines.push(`  - ${item.trigger} → ${item.learned}`);
      }
    }

    if (topExpertise.length) {
      lines.push(
        `- 관련 전문성: ${topExpertise.map((t) => t.item.domain).join(', ')}.`,
      );
    }

    const raw = `당신의 성격:\n${lines.join('\n')}`;
    const truncated = truncateToBudget(raw, this.config.snapshot.maxTokens);
    this.snapshotTruncatedLastCall = truncated.length < raw.length;

    return {
      summary: truncated,
      relevantBehaviors: topBehaviors.map(
        ({ item }) => `${item.trigger} → ${item.learned}`,
      ),
      relevantExpertise: topExpertise.map(({ item }) => item.domain),
      estimatedTokens: estimateTokens(truncated),
    };
  }

  async evolve(feedback: PersonaFeedback): Promise<EvolutionResult> {
    const persona = await this.load();
    const outcome: EvolutionOutcome = evolvePersona({
      persona,
      feedback,
      ...(this.config.evolutionRules ? { rules: this.config.evolutionRules } : {}),
    });
    if (outcome.changed) {
      await this.persist();
    }
    const result: EvolutionResult = { changed: outcome.changed };
    if (outcome.fieldPath !== undefined) result.fieldPath = outcome.fieldPath;
    if (outcome.delta !== undefined) result.delta = outcome.delta;
    if (outcome.reason !== undefined) result.reason = outcome.reason;
    return result;
  }

  /**
   * Periodic maintenance — apply the §4.2 decay rule to stored
   * learnedBehaviors. Returns the number of entries whose confidence changed.
   */
  async runDecay(): Promise<number> {
    const persona = await this.load();
    const n = applyDecay(persona, this.config.evolutionRules ?? {});
    if (n > 0) await this.persist();
    return n;
  }

  async export(): Promise<PersonaExport> {
    const persona = await this.load();
    const serialized = JSON.stringify(persona);
    return {
      format: 'ego-persona-v1',
      exportedAt: nowIso(),
      sourceAgentId: 'unknown',
      sourceInstanceId: 'unknown',
      persona,
      checksum: createHash('sha256').update(serialized).digest('hex'),
    };
  }

  async import(data: PersonaExport): Promise<void> {
    const persona: Persona = {
      ...data.persona,
      relationshipContext: {
        ...data.persona.relationshipContext,
        interactionStartDate: nowIso(),
        trustLevel: 0.5,
        communicationMaturity: 'new',
        milestones: [],
      },
    };
    this.cached = persona;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.cached, null, 2) + '\n', 'utf-8');
  }
}
