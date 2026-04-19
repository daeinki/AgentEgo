# Configuration Reference

모든 설정 파일·환경 변수·런타임 옵션 레퍼런스.

## 환경 변수

### 필수 (LLM 호출 시)

| 변수 | 용도 | 예시 |
|------|------|------|
| `ANTHROPIC_API_KEY` | Anthropic Claude 호출 (agent + EGO LLM) | `sk-ant-api03-...` |

### 선택

| 변수 | 용도 | 기본값 |
|------|------|--------|
| `OPENAI_API_KEY` | OpenAI 엠베더·LLM 폴백 | — |
| `AGENT_MODEL` | 에이전트 워커 기본 모델 | `claude-sonnet-4-20250514` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP 트레이스 수집기 (사용 시 `setupTelemetry` 에 전달) | — |

### 권장 배치

```bash
# .env (로컬 개발)
ANTHROPIC_API_KEY=sk-ant-api03-...
AGENT_MODEL=claude-sonnet-4-20250514
```

## `ego.json` — EGO 설정

**위치**: `~/.agent/ego/ego.json`
**형식**: strict JSON (주석 없음)
**읽는 주체**: EGO `loadEgoConfig()` / CLI `agent ego status`

### 전체 필드

```json5
{
  // 메타
  "schemaVersion": "1.1.0",              // breaking change 시 major bump

  // 핵심 상태 (ADR-006)
  "state": "active",                     // "off" | "passive" | "active"
  "fallbackOnError": true,               // 런타임 오류 시 Control Panel 직행
  "maxDecisionTimeMs": 3000,             // S1~S7 전체 타임아웃

  // EGO 전용 LLM
  "llm": {
    "provider": "anthropic",
    "model": "claude-haiku-4-5-20251001",
    "apiKey": "${ANTHROPIC_API_KEY}",    // ${VAR} 형식 환경변수 치환
    "temperature": 0.1,
    "maxTokens": 1024,
    "topP": 0.9,
    "fallback": {                        // 실패 시 폴백 (선택)
      "provider": "openai",
      "model": "gpt-4.1-mini",
      "apiKey": "${OPENAI_API_KEY}",
      "temperature": 0.1,
      "maxTokens": 1024
    }
  },

  // 판단 임계값
  "thresholds": {
    "minConfidenceToAct": 0.6,           // 미만 시 passthrough 강제
    "minRelevanceToEnrich": 0.3,
    "minRelevanceToRedirect": 0.5,
    "minRelevanceToDirectRespond": 0.8,
    "maxCostUsdPerDecision": 0.05,       // 호출당 하드 캡
    "maxCostUsdPerDay": 5.0              // 일일 누적 초과 시 state 자동 다운그레이드
  },

  // 빠른 경로 규칙 (LLM 없이)
  "fastPath": {
    "passthroughIntents": ["greeting", "command", "reaction"],
    "passthroughPatterns": [
      "^/(reset|status|new|compact|help)",
      "^(hi|hello|hey|안녕|ㅎㅇ|감사|고마워|ㄱㅅ)"
    ],
    "maxComplexityForPassthrough": "simple",  // trivial|simple|moderate|complex|multi_step
    "targetRatio": 0.75,                 // 목표 fast-exit 비율 (Phase EGO-4 실측 기준)
    "measurementWindowDays": 7
  },

  // 프롬프트
  "prompts": {
    "systemPromptFile": "~/.agent/ego/system-prompt.md",
    "responseFormat": "json"
  },

  // 목표 관리 (ADR-007)
  "goals": {
    "enabled": true,
    "maxActiveGoals": 10,
    "autoDetectCompletion": true,
    "storePath": "~/.agent/ego/goals.json"
  },

  // 메모리 연동
  "memory": {
    "searchOnCognize": true,             // 깊은 경로에서 메모리 검색 수행
    "maxSearchResults": 5,
    "searchTimeoutMs": 1500,
    "onTimeout": "empty_result"          // "empty_result" | "cached" | "abort"
  },

  // 페르소나 연동
  "persona": {
    "enabled": true,
    "storePath": "~/.agent/ego/persona.json",
    "snapshot": {
      "maxTokens": 250,
      "topRelevantBehaviors": 3,
      "topRelevantExpertise": 3,
      "includeRelationshipContext": true
    }
  },

  // 에러 처리 (§5.7)
  "errorHandling": {
    "onLlmInvalidJson": "passthrough",
    "onLlmTimeout": "passthrough",
    "onLlmOutOfRange": "passthrough",
    "onConsecutiveFailures": {
      "threshold": 5,
      "action": "disable_llm_path",
      "cooldownMinutes": 15
    }
  },

  // 감사
  "audit": {
    "enabled": true,
    "logLevel": "decisions",
    "storePath": "~/.agent/ego/audit.db",
    "retentionDays": 90
  }
}
```

### `state` 값 의미

| 값 | 경로 | LLM 호출 | 개입 |
|----|------|----------|------|
| `off` | 버스 → Control Panel 직행 | 없음 | 없음 (EGO 미호출) |
| `passive` | 버스 → EGO (판단) → Control Panel | ~25% | 없음 (감사 로그만) |
| `active` | 버스 → EGO (판단+개입) → Control Panel 또는 outbound | ~25% | passthrough/enrich/redirect/direct_response |

### `memory.onTimeout` 의미

| 값 | 동작 |
|----|------|
| `empty_result` | 빈 배열 반환, 감사 로그 기록 후 계속 (기본) |
| `cached` | 직전 성공 결과 재사용 (최대 60초) |
| `abort` | `EgoPipelineAbort` throw → `fallbackOnError` 규칙 적용 |

## `persona.json` — 페르소나 상태

**위치**: `~/.agent/ego/persona.json`
**형식**: strict JSON
**읽는 주체**: `FilePersonaManager`

```json5
{
  "version": "1.0.0",
  "personaId": "prs-a7f3c2",
  "createdAt": "2026-04-15T09:00:00Z",
  "updatedAt": "2026-04-15T14:30:00Z",
  "totalInteractions": 342,               // 상호작용 카운트 (진화 입력)
  "evolutionCount": 28,                   // 진화 발생 횟수

  "identity": {
    "name": "Molly",
    "role": "개인 AI 어시스턴트",
    "coreDirective": "사용자의 생산성과 웰빙을 돕는다"
  },

  "communicationStyle": {                 // 각 값은 [0, 1]
    "formality": 0.4,
    "verbosity": 0.3,
    "humor": 0.6,
    "empathy": 0.8,
    "directness": 0.7,
    "proactivity": 0.5,
    "preferredLanguage": "ko",
    "adaptToUser": true
  },

  "emotionalTendencies": {
    "defaultMood": "calm-positive",
    "sensitivityToFrustration": 0.7,
    "celebrationLevel": 0.6,
    "cautiousness": 0.5,
    "curiosity": 0.8,
    "patience": 0.9
  },

  "valuePriorities": {
    "accuracy": 0.9,
    "speed": 0.6,
    "privacy": 0.8,
    "creativity": 0.5,
    "costEfficiency": 0.7,
    "safety": 0.9,
    "autonomy": 0.4
  },

  "domainExpertise": [
    {
      "domain": "software-engineering",
      "confidence": 0.8,
      "subTopics": ["typescript", "system-design"],
      "learnedFrom": 156,
      "lastActive": "2026-04-15T14:00:00Z"
    }
  ],

  "learnedBehaviors": [
    {
      "trigger": "사용자가 코드 리뷰 요청",
      "learned": "보안 이슈를 먼저 확인 후 스타일 지적",
      "confidence": 0.85,
      "source": "correction",              // correction|positive-feedback|...
      "learnedAt": "2026-04-10T10:00:00Z"
    }
  ],

  "relationshipContext": {
    "interactionStartDate": "2026-03-01T00:00:00Z",
    "trustLevel": 0.85,
    "communicationMaturity": "established", // "new"(<30) | "developing"(<100) | "established"
    "knownPreferences": ["아침에는 간결한 답변"],
    "knownDislikes": ["과도한 이모지"],
    "insideJokes": [],
    "milestones": []
  },

  "evolutionLog": [
    {
      "timestamp": "2026-04-15T14:30:00Z",
      "trigger": "사용자가 '너무 길어'라고 피드백",
      "change": {
        "field": "communicationStyle.verbosity",
        "from": 0.5,
        "to": 0.3,
        "delta": -0.2
      },
      "reason": "반복된 간결함 요청 (3회차)"
    }
  ]
}
```

상세 진화 규칙은 [ego-persona.md §4](../../claude/ego-persona.md) 참조.

## `ego.json.persona.snapshot` 튜닝

| 필드 | 의미 | 기본값 |
|------|------|--------|
| `maxTokens` | 스냅샷 전체 토큰 상한 | 250 |
| `topRelevantBehaviors` | 관련 행동 패턴 top-K | 3 |
| `topRelevantExpertise` | 관련 도메인 전문성 top-K | 3 |
| `includeRelationshipContext` | 관계 맥락 포함 여부 | true |

## 런타임 옵션 — `startPlatform()`

CLI 가 내부적으로 사용하는 팩토리 ([packages/cli/src/runtime/platform.ts](../packages/cli/src/runtime/platform.ts)):

```ts
import { startPlatform } from '@agent-platform/cli/runtime';

const platform = await startPlatform({
  sessionsDbPath: './agent-sessions.db',
  palaceRoot: '~/.agent/memory',
  egoConfig: await loadEgoConfig(),
  egoLlm: new AnthropicEgoLlmAdapter(egoConfig.llm),
  modelAdapter: new AnthropicAdapter({ apiKey, model: 'claude-sonnet-4-20250514' }),
  gatewayPort: 18789,
  gatewayAuthTokens: ['dev-token'],
  webchatPort: 18790,
  webchatOwnerIds: ['owner-user-id'],
  telemetry: { exporter: 'console' },
});
```

## Gateway 설정

`ApiGateway` (control-plane) 는 생성자에서:

```ts
new ApiGateway({
  port: 18789,                          // 0 = ephemeral
  auth: { tokens: ['dev-token'] },      // bearer 토큰 허용 목록
  rateLimit: { capacity: 30, refillPerSecond: 2 },
  router,                               // Contracts.Router
  sessions,                             // SessionStore
  handler,                              // MessageHandler 콜백
});
```

HTTP 엔드포인트:
- `GET /healthz` — 비인증
- `GET /sessions/:id` — Bearer 인증
- `GET /sessions/:id/events?limit=N` — Bearer 인증
- `POST /sessions/:id/hibernate` — Bearer 인증
- `POST /sessions/:id/compact` — Bearer 인증
- `POST /messages` — Bearer 인증 + rate limit

WebSocket:
- `/ws` — Bearer 인증, envelope 포맷은 [packages/control-plane/src/gateway/envelope.ts](../packages/control-plane/src/gateway/envelope.ts)

## 채널별 설정

### WebChat
```ts
await webchat.initialize({
  type: 'webchat',
  port: 18790,
  credentials: {},
  conversationId: 'webchat-default',
  ownerIds: ['owner-user-id'],
});
```

### Telegram
```ts
await telegram.initialize({
  type: 'telegram',
  token: process.env.TELEGRAM_BOT_TOKEN!,
  credentials: {},
  pollTimeoutSec: 30,
  ownerIds: [123456789],
});
```

### Slack
```ts
await slack.initialize({
  type: 'slack',
  botToken: process.env.SLACK_BOT_TOKEN!,
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  credentials: {},
  port: 3000,                           // Events API 수신 포트
  ownerIds: ['U-owner'],
});
```

### Discord
```ts
await discord.initialize({
  type: 'discord',
  botToken: process.env.DISCORD_BOT_TOKEN!,
  credentials: {},
  ownerIds: ['user-id'],
});
// 별도로 Gateway 연결:
const gateway = new DiscordGatewayClient({ token: botToken });
gateway.onMessage((msg, isDm) => discord.injectMessage(msg, isDm));
await gateway.connect();
```

### WhatsApp (baileys)
```ts
// peer dep 설치 필요: pnpm add @whiskeysockets/baileys
import { createBaileysClient } from '@agent-platform/channel-whatsapp/baileys';
const client = await createBaileysClient({ authDir: '~/.agent/whatsapp-auth' });
await whatsapp.initialize({ type: 'whatsapp', client, credentials: {}, ownerIds: ['821012345678'] });
```

## 메시지 버스 선택

### InProcessBus (기본, 단일 프로세스)
```ts
import { InProcessBus } from '@agent-platform/message-bus';
const bus = new InProcessBus();
```

### RedisStreamsBus (분산)
```ts
// peer dep 설치 필요: pnpm add ioredis
import Redis from 'ioredis';
import { RedisStreamsBus } from '@agent-platform/message-bus';

const redis = new Redis('redis://localhost:6379');
const bus = new RedisStreamsBus({ client: redis, keyPrefix: 'agent:' });
```

## 관측 가능성 설정

```ts
import { setupTelemetry, createOtlpHttpProcessor } from '@agent-platform/observability';

// 개발: console 출력
const tel = setupTelemetry({ serviceName: 'agent-platform', exporter: 'console' });

// 테스트: 메모리 수집
const tel = setupTelemetry({ serviceName: 'agent-platform', exporter: 'memory' });

// 운영: OTLP (peer dep: @opentelemetry/exporter-trace-otlp-http)
const proc = await createOtlpHttpProcessor({
  url: 'http://otel-collector:4318/v1/traces',
  headers: { 'x-tenant': 'acme' },
});
const tel = setupTelemetry({
  serviceName: 'agent-platform',
  exporter: 'custom',
  customProcessors: [proc],
});
```

## 스킬 레지스트리 설정

```ts
import { LocalSkillRegistry } from '@agent-platform/skills';

const registry = new LocalSkillRegistry({
  installRoot: '~/.agent/skills',
  searchPaths: ['./skills'],            // 디스커버리 디렉토리
  signingSecret: process.env.SKILL_SIGNING_SECRET,  // HMAC 서명 강제 시
});
```

## 샌드박스 설정

### InProcessSandbox (기본)
```ts
const tools = new Map([
  ['fs.read', fsReadTool(['/allowed/paths'])],
  ['web.fetch', webFetchTool(['example.com', '*.trusted.com'])],
]);
const sandbox = new InProcessSandbox(tools);
```

### DockerSandbox
```ts
const runtime = new DockerContainerRuntime();
const tools = new Map([
  ['bash.run', bashTool({ memoryMb: 256, networkEnabled: false })],
]);
const sandbox = new DockerSandbox(tools, {
  defaultImage: 'alpine:latest',
  runtime,
  gvisorRuntime: 'runsc',               // gVisor 사용 시
});
```

## 관련 문서

- [getting-started.md](getting-started.md) — 설치부터 첫 대화
- [architecture.md](architecture.md) — 구조 개요
- [tutorials/](tutorials/) — 사용 예제
- [reference/cli.md](reference/cli.md) — CLI 명령어
