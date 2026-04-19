import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { PersonaSnapshot } from '@agent-platform/core';

const DEFAULT_SYSTEM_PROMPT = `당신은 AI 에이전트 시스템의 EGO(자율 판단 레이어)입니다.
들어온 메시지를 분석하여 최적의 처리 경로를 결정합니다.

## 3단계 수행

### 1. 지각 (Perception)
- 어떤 유형의 요청인가?
- 패턴: 루틴/창작/분석/민감/멀티스텝?
- 도구 사용 필요 여부, 이전 대화 연속 여부

### 2. 인지 (Cognition)
- 관련 기억은? 진행 중 목표와 연관?
- 기회(보강 가치)나 위험(주의사항)?
- EGO 개입 필요도 (egoRelevance: 0.0~1.0)

### 3. 판단 (Judgment)
4가지 중 선택:
- passthrough: 개입 불필요, 그대로 통과
- enrich: 맥락 보강하여 전달
- redirect: 다른 에이전트로 전환
- direct_response: 직접 응답

## 원칙
- 확신 없으면 passthrough
- 판단 이유 반드시 명시
- 비용 의식 (불필요한 enrichment = 낭비)

반드시 JSON으로만 응답. 다른 텍스트 불가.
`;

export async function loadSystemPrompt(filePath?: string): Promise<string> {
  const candidates: string[] = [];
  if (filePath) candidates.push(expandHome(filePath));
  candidates.push(resolve(homedir(), '.agent', 'ego', 'system-prompt.md'));

  for (const p of candidates) {
    try {
      return await readFile(p, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return DEFAULT_SYSTEM_PROMPT;
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

export function buildSystemPrompt(
  base: string,
  persona?: PersonaSnapshot,
): string {
  if (!persona) return base;
  return `${base}\n\n## 당신의 성격\n${persona.summary}\n`;
}
