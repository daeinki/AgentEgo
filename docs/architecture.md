# Architecture Overview

설계 문서 [`harness-engineering.md`](../../claude/harness-engineering.md) 의 ADR-001 ~ ADR-007 에
기반하며, 이 문서는 **구현 관점의 실제 코드 구조**를 설명합니다.

## 1. 전체 데이터 흐름

```
┌────────────────┐   ┌──────────────┐   ┌─────────────────┐   ┌───────────────┐
│ Channel Adapter│──▶│ Message Bus  │──▶│   EGO Layer    │──▶│ Control Plane │
│ (WS/Telegram   │   │ (InProcess/  │   │  (optional)    │   │ (Router +     │
│  /Slack/...)   │   │  Redis)      │   │                │   │  SessionMgr)  │
└────────────────┘   └──────────────┘   └────────┬───────┘   └───────┬───────┘
                                                 │                   │
                                                 │ invoke            │ route
                                                 ▼                   ▼
                                        ┌────────────────────────────────┐
                                        │     Agent Worker (Runner)      │
                                        │  prompt → LLM stream → tools   │
                                        └───────────┬────────────────────┘
                                                    │
                             ┌──────────────────────┼───────────────────────┐
                             ▼                      ▼                       ▼
                    ┌────────────────┐    ┌────────────────┐      ┌────────────────┐
                    │ Memory System  │    │  Tool Sandbox  │      │ Observability  │
                    │ (Palace+FTS5)  │    │ (InProc/Docker)│      │ (OTel+Metrics) │
                    └────────────────┘    └────────────────┘      └────────────────┘
```

**EGO 토글**:
- `state = 'off'` — Channel → Bus → Control Plane (EGO 건너뜀)
- `state = 'passive'` — EGO 가 판단만 수행, 통과 그대로
- `state = 'active'` — EGO 가 판단 + 개입 (enrich/redirect/direct_response)

## 2. 14 패키지 지도

```
packages/
├── core                  ◀─── 모든 패키지가 여기의 타입을 import
│   ├── src/schema/*      TypeBox 런타임 스키마 (Message, Session, EGO,
│   │                     Goal, Persona, Memory, Observability, Capability,
│   │                     Routing, Prompt, Model, Tool, Sandbox, Skill)
│   ├── src/contracts/*   타입 전용 인터페이스 (14개)
│   ├── src/ids.ts        브랜드 타입 ID 생성기 (uuid v7 기반)
│   ├── src/adr/state.ts  ADR-006 EgoState 전이 헬퍼
│   └── src/errors.ts     공유 에러 클래스
│
├── control-plane
│   ├── session/store.ts    SessionStore (SQLite) — 세션 + 이벤트 CRUD + compact
│   ├── session/manager.ts  ControlPlaneSessionManager (Contracts.SessionManager)
│   ├── session/router.ts   RuleRouter (규칙 기반 라우팅) + Router (레거시)
│   └── gateway/
│       ├── server.ts       ApiGateway (HTTP + WS, /healthz, /messages, /ws)
│       ├── auth.ts         TokenAuth (Bearer 토큰)
│       ├── rate-limiter.ts 토큰 버킷 레이트리미터
│       └── envelope.ts     WebSocket envelope 스키마
│
├── ego
│   ├── signal.ts           S1 Intake (StandardMessage → EgoSignal)
│   ├── normalize.ts        S2 classifier (intent/urgency/entities/complexity)
│   ├── layer.ts            S1~S7 전체 파이프라인 (EgoLayer)
│   ├── llm-adapter.ts      AnthropicEgoLlmAdapter (JSON 출력)
│   ├── circuit-breaker.ts  연속 실패 서킷브레이커 (§5.7)
│   ├── context-gatherer.ts 메모리/목표/최근 대화 병렬 수집 (§5.8)
│   ├── goal-store.ts       FileGoalStore (JSON 파일)
│   ├── persona-manager.ts  FilePersonaManager (load/snapshot/evolve)
│   ├── persona-evolution.ts 진화 규칙 (§4)
│   ├── audit-log.ts        SqliteAuditLog
│   ├── redirect.ts         §3.2A.5a 세션 전이 절차
│   └── feedback-parser.ts  LlmFeedbackParser
│
├── memory
│   ├── palace-memory.ts    PalaceMemorySystem (MemorySystem 구현)
│   ├── db/store.ts         MemoryChunkStore (SQLite FTS5)
│   ├── embedding/          HashEmbedder (오프라인) + HttpEmbedder (OpenAI/Voyage/Ollama)
│   ├── ingest/             chunker + 분류기 + ingest 파이프라인
│   ├── search/hybrid.ts    BM25 + vector + structure boost
│   └── llm-compactor.ts    LLM 기반 청크 요약
│
├── agent-worker
│   ├── runner/agent-runner.ts  AgentRunner (턴 실행 루프)
│   ├── prompt/builder.ts       PromptBuilder (EGO enrichment 주입)
│   ├── model/anthropic.ts      AnthropicAdapter (ModelAdapter 구현)
│   ├── tools/
│   │   ├── built-in.ts         fsRead/fsWrite/webFetch
│   │   ├── sandbox.ts          InProcessSandbox
│   │   ├── docker-sandbox.ts   DockerSandbox (DockerTool 프로토콜)
│   │   └── bash-tool.ts        bash.run (컨테이너 강제)
│   └── security/
│       └── capability-guard.ts PolicyCapabilityGuard
│
├── observability
│   ├── setup.ts           setupTelemetry (console/memory/otlp/none)
│   ├── tracer.ts          withSpan 헬퍼
│   ├── metrics.ts         InMemoryMetricsSink
│   └── otlp.ts            OTLP HTTP 프로세서 (dynamic import)
│
├── skills
│   ├── manifest.ts        SkillManifest TypeBox 스키마
│   ├── hash.ts            hashSkillDirectory (SHA-256)
│   ├── local-registry.ts  LocalSkillRegistry (search/install/verify/listInstalled)
│   ├── loader.ts          dynamic import → createTools()
│   └── tool-registrar.ts  mountInstalledSkills (집계 + 중복 감지)
│
├── message-bus
│   ├── bus.ts             MessageBus 인터페이스
│   ├── in-process-bus.ts  InProcessBus (단일 프로세스)
│   └── redis-streams-bus.ts  RedisStreamsBus (RedisLike 주입)
│
├── workflow
│   ├── schema.ts          Workflow DSL 타입 + validateWorkflow
│   └── engine.ts          executeWorkflow 인터프리터
│
├── device-node
│   ├── protocol.ts        envelope 스키마 (hello/heartbeat/message/ack)
│   ├── pairing.ts         pairing code + HMAC-SHA256 토큰
│   └── server.ts          DeviceNodeServer (WS /device)
│
├── cli
│   ├── program.ts         Commander.js 커맨드 등록
│   ├── commands/          send / status / ego
│   └── runtime/
│       └── platform.ts    startPlatform() — 모든 컴포넌트 와이어링
│
└── channels/
    ├── webchat/           브라우저 WS 어댑터 (/webchat)
    ├── telegram/          Bot API 롱폴링 + mock client 테스트
    ├── slack/             Events API webhook + Web API + 서명 검증
    ├── discord/           REST 클라이언트 + Gateway WS (v10)
    └── whatsapp/          WhatsAppClient 추상 + baileys (optional peer)
```

## 3. 컨트랙트 기반 확장성

플랫폼 모든 경계는 `@agent-platform/core/contracts` 인터페이스로 추상화:

| 인터페이스 | 기본 구현 | 교체 가능한 대안 |
|-----------|-----------|-------------------|
| `ChannelAdapter` | WebChat | Telegram/Slack/Discord/WhatsApp |
| `SessionManager` | ControlPlaneSessionManager (SQLite) | — (미래: PostgreSQL) |
| `Router` | RuleRouter | 커스텀 규칙 엔진 |
| `EgoLayer` | EgoLayer | — |
| `EgoLlmAdapter` | AnthropicEgoLlmAdapter | OpenAI/Gemini/ollama |
| `MemorySystem` | PalaceMemorySystem | — (sqlite-vec 교체 가능) |
| `PromptBuilder` | PromptBuilder | 커스텀 계층 전략 |
| `ModelAdapter` | AnthropicAdapter | OpenAI/Gemini/ollama |
| `CapabilityGuard` | PolicyCapabilityGuard | LDAP/OPA 통합 |
| `ToolSandbox` | InProcessSandbox / DockerSandbox | gVisor/kata |
| `SkillRegistry` | LocalSkillRegistry | 원격 레지스트리 |
| `GoalStore` | FileGoalStore | — |
| `PersonaManager` | FilePersonaManager | — |
| `AuditLog` | SqliteAuditLog | Elasticsearch/Loki |

## 4. EGO 파이프라인 상세

```
StandardMessage
    │
════╪════════════════════  빠른 경로 (규칙, ~16ms)
    ▼
 S1 Intake        → EgoSignal 변환 (<1ms)
    ▼
 S2 Normalize     → intent/urgency/entities/complexity (<5ms)
    ▼
 shouldFastExit?  ───── true → passthrough (~75% 목표)
    │ false
════╪════════════════════  깊은 경로 (~2s)
    ▼
 gatherContext    → memory + goals + recent turns (병렬, <1500ms)
    ▼
 buildSystemPrompt → persona snapshot 주입
    ▼
 EgoLlmAdapter.think → Claude Haiku, JSON 응답 (500~1500ms)
    ▼
 validateEgoThinking → 스키마 검증 + 의미적 일관성 체크
    ▼
 임계값 오버라이드  → confidence < minConfidenceToAct 면 passthrough
    ▼
 state-aware materialize → passive 면 passthrough 로 강제
    ▼
 EgoDecision      → { passthrough | enrich | redirect | direct_response }
    ▼
 audit.record     → 감사 로그 기록
```

## 5. 메모리 검색 전략

하이브리드 검색 (`memory/src/search/hybrid.ts`):

```
query "TypeScript 배포 파이프라인"
    ├─ BM25 via FTS5  (상위 50 후보) → 정규화 점수
    ├─ Vector cosine  (모든 후보에 대해) → 정규화 점수
    └─ Structure boost (preferredWings 내 청크에 +1)
        ↓
    weighted combine: bm25*0.45 + vector*0.45 + boost*0.1
        ↓
    minRelevanceScore 필터 → maxResults (기본 5)
```

## 6. 세션 ↔ 메시지 수명

```
user message 도착
    │
    ├─ Router.route(msg) → RouteDecision { agentId, sessionId, priority }
    │
    ├─ SessionStore.resolveSession(agentId, channelType, conversationId)
    │  └─ 없으면 생성, 있으면 reuse
    │
    ├─ EgoLayer.process(msg, { sessionId, agentId }) (state≠off)
    │
    ├─ AgentRunner.processTurn(sessionId, effectiveMsg)
    │  ├─ 최근 50개 이벤트 로드
    │  ├─ PromptBuilder.build (EGO enrichment 포함)
    │  ├─ ModelAdapter.stream → onChunk 콜백
    │  ├─ SessionStore.addEvent (user_message)
    │  ├─ SessionStore.addEvent (agent_response)
    │  └─ memory.ingest (선택적, 비파괴)
    │
    └─ 응답 스트리밍 완료
```

세션 상태 전이 (`Session.status`):
- `active` — 기본
- `hibernated` — 명시적 hibernate
- `archived` — 오래된 세션 아카이브
- `redirected` — §3.2A.5a EGO redirect 후 (metadata.redirectedTo 포함)

## 7. 설정 source-of-truth

| 설정 | 위치 | 형식 | 쓰는 주체 |
|------|------|------|----------|
| EGO | `~/.agent/ego/ego.json` | strict JSON | CLI / EGO |
| Persona | `~/.agent/ego/persona.json` | strict JSON | PersonaManager |
| Goals | `~/.agent/ego/goals.json` | strict JSON | FileGoalStore |
| Audit | `~/.agent/ego/audit.db` | SQLite | SqliteAuditLog |
| Sessions | `./agent-sessions.db` | SQLite | SessionStore |
| Memory | `~/.agent/memory/palace.db` + `wings/` | SQLite + Markdown | PalaceMemorySystem |
| System prompt | `~/.agent/ego/system-prompt.md` | Markdown | EGO |

경로 분리 원칙: `~/.agent/memory/` 는 메모리 시스템 전용, `~/.agent/ego/` 는 EGO 전용. 서로 직접 쓰지 않음.

## 8. 관측 가능성 3가지 기둥

- **Traces** — `@opentelemetry/api` 기반, `withSpan()` 헬퍼로 S1~S7 각 단계 커버
- **Metrics** — `InMemoryMetricsSink` (턴 수, 토큰, 비용, EGO fast-exit 비율, audit tag counts)
- **Audit logs** — SQLite 기반 `ego_audit` 테이블, 20+ 태그 (ego_decision/ego_timeout/llm_schema_mismatch/daily_cost_cap_hit/...)

## 9. 관련 문서

- [getting-started.md](getting-started.md) — 설치 + 첫 대화
- [configuration.md](configuration.md) — 모든 설정 파일 필드
- [tutorials/](tutorials/) — 단계별 사용 예제
- 원본 설계: [harness-engineering.md](../../claude/harness-engineering.md), [ego-design.md](../../claude/ego-design.md), [ego-persona.md](../../claude/ego-persona.md)
