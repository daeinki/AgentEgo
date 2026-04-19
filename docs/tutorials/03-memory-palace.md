# Tutorial 03 — Memory Palace

**목표**: Palace 메모리 시스템을 도입해 대화가 자동 기억되고, 나중에 관련 기억이 EGO enrich 경로로
재주입되는 흐름 관찰.
**소요 시간**: 15분
**전제**: [튜토리얼 02](02-enable-ego.md) 완료, EGO `state: 'active'`, EGO LLM 구성됨

## 메모리 팰리스 개요

`personal / work / knowledge / interactions` 네 wing 으로 자동 분류되는 SQLite+Markdown
하이브리드 저장소:

```
~/.agent/memory/
├── palace.db                  ← SQLite (FTS5 + 벡터 인덱스)
├── wings/
│   ├── personal/              ← 선호도/연락처/루틴
│   ├── work/                  ← 프로젝트/회의/결정
│   ├── knowledge/             ← 학습된 지식/기술
│   └── interactions/          ← 교정·피드백 패턴
├── daily/                     ← YYYY-MM-DD.md 일일 로그
└── archive/                   ← 압축 아카이브
```

## Step 1: 런타임 플랫폼 스크립트

메모리 팰리스는 현재 CLI `send` 에 직접 와이어링 되어 있지 않습니다 (튜토리얼 01/02는 `send` 의
최소 경로). 메모리를 포함한 풀 스택을 돌리려면 `startPlatform()` 을 사용합니다.

`run-platform.ts` 라는 임시 스크립트를 만듭니다:

```ts
// run-platform.ts
import 'dotenv/config';
import { startPlatform } from '@agent-platform/cli/dist/runtime/platform.js';
import { AnthropicAdapter } from '@agent-platform/agent-worker';
import { AnthropicEgoLlmAdapter } from '@agent-platform/ego';
import { loadEgoConfig } from '@agent-platform/ego';

async function main() {
  const egoConfig = await loadEgoConfig();
  if (!egoConfig) throw new Error('ego.json 없음 — tutorial 02 먼저 완료');

  const egoLlm = new AnthropicEgoLlmAdapter();
  if (egoConfig.llm) await egoLlm.initialize(egoConfig.llm);

  const platform = await startPlatform({
    sessionsDbPath: './agent-sessions.db',
    palaceRoot: process.env.HOME + '/.agent/memory',
    egoConfig,
    egoLlm: egoConfig.llm ? egoLlm : undefined,
    modelAdapter: new AnthropicAdapter({
      apiKey: process.env.ANTHROPIC_API_KEY!,
      model: 'claude-sonnet-4-20250514',
    }),
    gatewayPort: 18789,
    gatewayAuthTokens: ['dev-token'],
    webchatPort: 18790,
    telemetry: { exporter: 'console' },
  });

  console.log(`Gateway on ${platform.ports.gateway}, WebChat on ${platform.ports.webchat}`);
  console.log('Send messages with:');
  console.log('  curl -X POST http://127.0.0.1:' + platform.ports.gateway + '/messages \\');
  console.log('    -H "Authorization: Bearer dev-token" \\');
  console.log('    -H "Content-Type: application/json" \\');
  console.log('    -d \'{"id":"m1","traceId":"t1","timestamp":1700000000,"channel":{"type":"webchat","id":"c","metadata":{}},"sender":{"id":"u","isOwner":true},"conversation":{"type":"dm","id":"conv-1"},"content":{"type":"text","text":"안녕"}}\'');

  process.on('SIGINT', async () => {
    await platform.shutdown();
    process.exit(0);
  });
}

main().catch(console.error);
```

## Step 2: 플랫폼 띄우기

```bash
# 먼저 빌드 (한 번만)
pnpm -r run build

# tsx 로 실행
npx tsx run-platform.ts
```

```
Gateway on 18789, WebChat on 18790
Send messages with: ...
```

다른 터미널에서 메시지 3개 보냅니다:

```bash
# 메시지 1 — 기술 스택 정보 기록
curl -X POST http://127.0.0.1:18789/messages \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "m1", "traceId": "t1", "timestamp": 1700000000,
    "channel": { "type": "webchat", "id": "c", "metadata": {} },
    "sender": { "id": "u", "isOwner": true },
    "conversation": { "type": "dm", "id": "conv-1" },
    "content": { "type": "text", "text": "우리 팀은 TypeScript + React + PostgreSQL 스택을 쓰고 있어" }
  }'
```

```bash
# 메시지 2 — 프로젝트 정보
curl -X POST http://127.0.0.1:18789/messages \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "m2", "traceId": "t2", "timestamp": 1700000100,
    "channel": { "type": "webchat", "id": "c", "metadata": {} },
    "sender": { "id": "u", "isOwner": true },
    "conversation": { "type": "dm", "id": "conv-1" },
    "content": { "type": "text", "text": "현재 auth 모듈 리팩토링 중이야 JWT 검증에서 버그가 있어서" }
  }'
```

## Step 3: 메모리 적재 확인

```bash
ls ~/.agent/memory/wings/
# personal  work  knowledge  interactions

cat ~/.agent/memory/wings/knowledge/technical.md
```

출력:
```markdown
## 2026-04-17T12:34:56.123Z — turn conv-1

[user] 우리 팀은 TypeScript + React + PostgreSQL 스택을 쓰고 있어

[assistant] 좋은 스택이네요! ...
```

자동 분류 규칙 (`memory/src/ingest/classifier.ts`) 이 "TypeScript" / "JWT" 등의 키워드를 보고
`knowledge/technical` wing 으로 배정합니다.

SQLite 에서도 확인:
```bash
sqlite3 ~/.agent/memory/palace.db

sqlite> SELECT id, wing, content FROM memory_chunks LIMIT 5;
```

## Step 4: 검색 트리거하기

이제 **앞서 쌓인 메모리를 참조해야만 답할 수 있는 질문**을 보냅니다:

```bash
curl -X POST http://127.0.0.1:18789/messages \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "m3", "traceId": "t3", "timestamp": 1700000200,
    "channel": { "type": "webchat", "id": "c", "metadata": {} },
    "sender": { "id": "u", "isOwner": true },
    "conversation": { "type": "dm", "id": "conv-1" },
    "content": { "type": "text", "text": "우리 팀 프론트엔드 스택에 맞는 상태 관리 라이브러리 추천해줘, 현재 진행 중인 리팩토링과 조화롭게" }
  }'
```

내부 흐름:
1. EGO S1/S2 — `complexity: 'complex'`, `intent: 'question'` → 빠른 경로 못 탐
2. 깊은 경로 진입 → `gatherContext` 에서 메모리 검색
3. 쿼리: "프론트엔드 스택 상태 관리 리팩토링" → BM25 + vector 하이브리드 매칭
4. 상위 결과에 메시지 1+2 의 청크 반환 (TypeScript/React/auth 맥락)
5. EGO LLM 이 `relevantMemoryIndices: [0, 1]` 로 관련 메모리 인지, `egoRelevance: 0.8+`
6. 판단: `enrich` — 메모리 내용을 시스템 프롬프트에 주입
7. 에이전트 워커가 enrichment 가 반영된 프롬프트로 Sonnet 호출 → **React 기반 추천** + auth
   리팩토링 영향 고려한 응답

## Step 5: 관측 데이터 확인

플랫폼은 `InMemoryMetricsSink` 를 기본 내장합니다. 런타임 스크립트에서 노출:

```ts
console.log('Metrics:', platform.metrics.snapshot());
```

예시 출력 (메시지 3개 후):
```js
{
  turns: 3,
  totalInputTokens: 450,
  totalOutputTokens: 280,
  totalCostUsd: 0.0042,
  avgTurnLatencyMs: 1820,
  egoDecisions: 3,
  egoFastExits: 0,             // 세 번 다 깊은 경로
  egoFastExitRatio: 0,
  auditTagCounts: {},
  egoActionCounts: {
    passthrough: 2,
    enrich: 1                  // 메시지 3이 enrich 됨
  }
}
```

## Step 6: 메모리 검색 수동 호출

Node REPL 에서 직접 검색해볼 수 있습니다:

```bash
node --input-type=module -e "
import { PalaceMemorySystem } from '@agent-platform/memory';

const mem = new PalaceMemorySystem({ root: process.env.HOME + '/.agent/memory' });
await mem.init();

const results = await mem.search('TypeScript 상태관리', {
  sessionId: 's', agentId: 'a',
  recentTopics: ['React', 'auth'],
  maxResults: 3,
  minRelevanceScore: 0,
});

console.log(JSON.stringify(results, null, 2));
await mem.close();
"
```

응답:
```json
[
  {
    "content": "[user] 우리 팀은 TypeScript + React + PostgreSQL...",
    "source": {
      "wing": "knowledge",
      "file": "/home/.../wings/knowledge/technical.md",
      "lineRange": [2, 3]
    },
    "relevance": {
      "bm25Score": 0.92,
      "vectorScore": 0.54,
      "structureBoost": 0,
      "combinedScore": 0.657
    },
    ...
  }
]
```

## Step 7: Compaction (오래된 청크 요약)

시간이 지나면 메모리가 커집니다. `compact()` 로 오래된 청크를 요약으로 롤업:

```bash
node --input-type=module -e "
import { PalaceMemorySystem } from '@agent-platform/memory';
const mem = new PalaceMemorySystem({ root: process.env.HOME + '/.agent/memory' });
await mem.init();
const result = await mem.compact('work', new Date(Date.now() - 30 * 86400000));
console.log(result);
await mem.close();
"
```

30일 이상 된 work wing 청크들이 하나의 summary 청크로 축약됩니다. LLM 기반 요약을 쓰려면
`LlmCompactor` 를 `PalaceMemorySystem` 생성 시 주입:

```ts
import { LlmCompactor } from '@agent-platform/memory';
const compactor = new LlmCompactor({ model: anthropicAdapter, targetSummaryTokens: 300 });
const mem = new PalaceMemorySystem({ root, compactor });
```

## 튜토리얼 정리

- ✅ 플랫폼 `startPlatform()` 으로 풀 스택 와이어링
- ✅ 메시지가 자동으로 wing 분류 + 파일 append + SQLite 인덱스
- ✅ EGO 깊은 경로가 메모리 검색 결과를 LLM 입력으로 전달
- ✅ enrich 판단 시 메모리 맥락이 에이전트 워커 프롬프트에 주입됨
- ✅ BM25 + vector + structure boost 하이브리드 검색
- ✅ 주기적 compaction 으로 메모리 크기 관리

## 다음

HTTP API 대신 브라우저에서 직접 대화하려면 [튜토리얼 04: WebChat 브라우저](04-webchat-browser.md)
로 이동하세요.

## 관련 문서

- [architecture.md §5](../architecture.md) — 메모리 검색 전략 상세
- [configuration.md](../configuration.md) — 메모리 관련 설정
- [harness-engineering.md §3.4](../../../claude/harness-engineering.md) — 원본 설계
