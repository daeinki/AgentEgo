# Architecture Overview

설계 문서 [`harness-engineering.md`](../../claude/harness-engineering.md) 의 ADR-001 ~ ADR-010 에
기반하며, 이 문서는 **구현 관점의 실제 코드 구조**를 설명합니다.

## 1. 전체 데이터 흐름

```
직접 운영자 서피스 (ADR-008/010)
┌─────────────────┐    ┌──────────────────────┐
│ TUI (Ink+React) │    │ Webapp (Lit 3 SPA)   │
│ Bearer master   │    │ ed25519 device-id +  │
│                 │    │ HMAC session token   │
└────────┬────────┘    └──────────┬───────────┘
         │                        │
         │ ws://…/rpc (JSON-RPC 2.0, chat.phase shared)
         └────────────┬───────────┘
                      │
                      ▼
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

**운영자 서피스 (ADR-008/010)**:

- TUI (`packages/tui`) 와 Webapp (`packages/webapp`) 은 모두 `/rpc` JSON-RPC 2.0 엔드포인트에서 동일한 메서드를 소비 — `chat.*`, `sessions.*`, `overview.status`, `channels.list`, `instances.list`, `cron.list`.
- 인증 차등: TUI 는 `Authorization: Bearer <master>`, Webapp 은 `Sec-WebSocket-Protocol: bearer.<sessionToken>` 서브프로토콜 + ed25519 device-identity enrollment.
- 공유 Phase 스트림: `chat.phase` JSON-RPC notification 을 둘 다 구독, `packages/core/src/schema/phase-format.ts` 의 `formatPhase` 로 동일 문자열 렌더(`[🔧 bash_run] 3.2s` 등).

## 2. 패키지 지도

```
packages/
├── core                  ◀─── 모든 패키지가 여기의 타입을 import
│   ├── src/schema/*      TypeBox 런타임 스키마 (Message, Session, EGO,
│   │                     Goal, Persona, Memory, Observability, Capability,
│   │                     Routing, Prompt, Model, Tool, Sandbox, Skill)
│   ├── src/contracts/*   타입 전용 인터페이스 (16개 — Reasoner/TraceLogger 포함)
│   ├── src/ids.ts        브랜드 타입 ID 생성기 (uuid v7 기반)
│   ├── src/adr/state.ts  ADR-006 EgoState 전이 헬퍼
│   └── src/errors.ts     공유 에러 클래스
│
├── control-plane
│   ├── session/store.ts    SessionStore (SQLite) — 세션 + 이벤트 CRUD + compact
│   ├── session/manager.ts  ControlPlaneSessionManager (Contracts.SessionManager)
│   ├── session/router.ts   RuleRouter (규칙 기반 라우팅) + Router (레거시)
│   └── gateway/
│       ├── server.ts       ApiGateway (HTTP + WS, /healthz, /messages, /ws,
│       │                   /rpc mount, /device/*, /ui/*)
│       ├── auth.ts         TokenAuth (Bearer + 선택적 secondary verifier)
│       ├── device-auth.ts  DeviceAuthStore (ed25519 enroll/assert + HMAC 토큰,
│       │                   ADR-010)
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
│   ├── runner/agent-runner.ts  AgentRunner (턴 실행 루프, HybridReasoner 위임)
│   ├── prompt/builder.ts       PromptBuilder (EGO enrichment 주입)
│   ├── model/anthropic.ts      AnthropicAdapter (ModelAdapter 구현, SDK 0.88)
│   ├── model/openai.ts         OpenAIAdapter (responseFormat=json_object)
│   ├── reasoning/              ADR-009 Reasoning 레이어
│   │   ├── hybrid-reasoner.ts        HybridReasoner (Reasoner 구현)
│   │   ├── complexity-router.ts      EGO perception → ReAct vs Plan-Execute
│   │   ├── react-executor.ts         Thought/Action/Observation 루프
│   │   ├── plan-execute-executor.ts  planner JSON 모드 + replan 트리거
│   │   └── step-matcher.ts           replan 단계 보존 (id + 의미 fallback)
│   ├── tools/
│   │   ├── built-in.ts         fsRead/fsWrite/webFetch
│   │   ├── sandbox.ts          InProcessSandbox
│   │   ├── docker-sandbox.ts   DockerSandbox (DockerTool 프로토콜)
│   │   └── bash-tool.ts        bash.run (컨테이너 강제)
│   └── security/
│       └── capability-guard.ts PolicyCapabilityGuard
│
├── observability
│   ├── setup.ts             setupTelemetry (console/memory/otlp/none)
│   ├── tracer.ts            withSpan 헬퍼
│   ├── metrics.ts           InMemoryMetricsSink
│   ├── otlp.ts              OTLP HTTP 프로세서 (dynamic import)
│   ├── sqlite-trace-log.ts  SqliteTraceLog (TraceLogger 구현, blocks G*/E*/W*/R*/M*/S*/K*/X*)
│   └── trace-query.ts       trace 조회 + 14일 보존 prune
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
│   └── engine.ts          executeWorkflow 인터프리터 (call/return/try/catch/scope)
│
├── scheduler              ◀─── ADR 부속 — cron + 3 runner
│   ├── scheduler.ts       SchedulerService (node-cron 래퍼)
│   ├── json-task-store.ts tasks.json (JSON5) 영속화
│   └── runners/           chat-runner / bash-runner / workflow-runner
│
├── device-node
│   ├── protocol.ts        envelope 스키마 (hello/heartbeat/message/ack)
│   ├── pairing.ts         pairing code + HMAC-SHA256 토큰
│   └── server.ts          DeviceNodeServer (WS /device)
│
├── gateway-cli            ◀─── 데몬 게이트웨이 + JSON-RPC 서버 (ADR-008)
│   ├── rpc/server.ts      RpcServer (JSON-RPC 2.0 over WS, notify 지원)
│   ├── rpc/methods.ts     chat.send/history, sessions.list/events/reset,
│   │                      overview.status, channels.list/status,
│   │                      instances.list, cron.list/runNow,
│   │                      gateway.health/shutdown
│   ├── lifecycle/         pid/port 파일 + detach fork + 상태 디렉토리
│   └── service/           launchd / systemd-user / schtasks 어댑터
│
├── tui                    ◀─── Ink + React 터미널 대시보드 (ADR-008)
│   ├── App.tsx            최상위 — PhaseLine/ChatHistory/InputBar
│   ├── hooks/useRpc.ts    WS 재연결 + notification 라우팅
│   └── lib/rpc-client.ts  Node ws 기반 JSON-RPC 클라이언트
│
├── webapp                 ◀─── Vite + Lit 3 브라우저 대시보드 (ADR-010)
│   ├── src/main.ts        엔트리 (app-root 마운트)
│   ├── src/ui/components/ app-root / app-header / app-sidebar / phase-line /
│   │                      enroll-dialog / health-indicator / theme-toggle / nav-item
│   ├── src/ui/views/      view-chat / view-overview / view-channels /
│   │                      view-instances / view-sessions / view-cron
│   ├── src/ui/chat/       chat-transcript / chat-bubble / chat-input
│   └── src/ui/controllers/gateway (ReactiveController) / chat / phase /
│                          polling / view-state / device-identity /
│                          rpc-client (browser)
│
├── cli
│   ├── program.ts         Commander.js 커맨드 등록
│   ├── commands/          send / status / ego / gateway / tui / device / trace
│   └── runtime/
│       └── platform.ts    startPlatform() — 모든 컴포넌트 와이어링
│                          (ADR-010: devicesFile 기본 주입)
│
└── channels/
    ├── webchat/           브라우저 WS 어댑터 (/webchat)
    ├── telegram/          Bot API 롱폴링 + mock client 테스트
    ├── slack/             transport union — Events API webhook | Socket Mode WS
    │                       (apps.connections.open + envelope ack + 자동 재접속)
    ├── discord/           REST + Gateway WS (v10) — Resume(op6) + sharding
    │                       (DiscordShardManager, READY session_id 캐시)
    └── whatsapp/          WhatsAppClient 추상
                            ├─ Cloud API (graph.facebook.com + X-Hub-Signature-256 HMAC)
                            └─ baileys QR (optional peer, ⚠️ 실 디바이스 미검증)
```

## 3. 컨트랙트 기반 확장성

플랫폼 모든 경계는 `@agent-platform/core/contracts` 인터페이스로 추상화:

| 인터페이스        | 기본 구현                             | 교체 가능한 대안                |
| ----------------- | ------------------------------------- | ------------------------------- |
| `ChannelAdapter`  | WebChat                               | Telegram/Slack/Discord/WhatsApp |
| `SessionManager`  | ControlPlaneSessionManager (SQLite)   | — (미래: PostgreSQL)            |
| `Router`          | RuleRouter                            | 커스텀 규칙 엔진                |
| `EgoLayer`        | EgoLayer                              | —                               |
| `EgoLlmAdapter`   | AnthropicEgoLlmAdapter                | OpenAI/Gemini/ollama            |
| `MemorySystem`    | PalaceMemorySystem                    | — (sqlite-vec 교체 가능)        |
| `PromptBuilder`   | PromptBuilder                         | 커스텀 계층 전략                |
| `ModelAdapter`    | AnthropicAdapter                      | OpenAI/Gemini/ollama            |
| `CapabilityGuard` | PolicyCapabilityGuard                 | LDAP/OPA 통합                   |
| `ToolSandbox`     | InProcessSandbox / DockerSandbox      | gVisor/kata                     |
| `SkillRegistry`   | LocalSkillRegistry                    | 원격 레지스트리                 |
| `GoalStore`       | FileGoalStore                         | —                               |
| `PersonaManager`  | FilePersonaManager                    | —                               |
| `AuditLog`        | SqliteAuditLog                        | Elasticsearch/Loki              |
| `Reasoner`        | HybridReasoner (ReAct + Plan-Execute) | 단일 모드 전용 reasoner         |
| `TraceLogger`     | SqliteTraceLog                        | OTLP collector / Tempo          |

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

부속 안전장치:

- **CircuitBreaker** (`circuit-breaker.ts`) — 연속 실패 N회 시 깊은 경로를 차단하고 일정 시간 동안 passthrough 로만 동작.
- **Daily cost cap auto-downgrade** — `thresholds.maxCostUsdPerDay` 도달 시 `state` 를 자동 다운그레이드 (active → passive → off). 감사 로그에 `daily_cost_cap_hit` 태그로 기록.
- **State 강등 흐름**: `off` 면 EGO 호출 자체가 생략 (Channel → Bus → Control Plane 직행), `passive` 는 판단만 수행 후 무조건 passthrough.

## 4.5 Reasoning 레이어 (ADR-009)

`AgentRunner` 는 `HybridReasoner` 에 위임하고, `ComplexityRouter` 가 EGO 의 `perception.estimatedComplexity` 를 직접 입력으로 받아 두 실행기를 분기:

```
EgoThinkingResult.perception.estimatedComplexity
    ├─ low                     → ReactExecutor   (Thought/Action/Observation, 도구 2회 재시도)
    └─ medium | high           → PlanExecuteExecutor
                                  ├─ planner LLM JSON 모드 (provider 별 강제)
                                  ├─ replan 트리거
                                  │   ├─ #1  stepRetry 소진       ✅
                                  │   ├─ #2  LLM judge            ❌ (비용 사유 보류)
                                  │   └─ #3  egoRelevance>0.8 + goalUpdates ✅
                                  ├─ 단계 보존: id 매칭 + StepMatcher 의미 fallback (threshold 0.85)
                                  └─ 한도 초과 시 ReAct 다운그레이드

requestType === 'workflow_execution' → 항상 plan-execute 강제
EGO off                              → 휴리스틱 (sentence count + imperative verbs + tool 후보 수)
```

`EgoThinkingResult.cognition.recommendedSteps` 와 `goalUpdates` 가 채워져 있으면 planner 에 hint 로 주입된다.

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
    │  ├─ HybridReasoner.run (도구 있을 때 — ReAct vs Plan-Execute 분기, §4.5)
    │  │   └─ ModelAdapter.stream → onChunk 콜백
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

| 설정          | 위치                                   | 형식              | 쓰는 주체                 |
| ------------- | -------------------------------------- | ----------------- | ------------------------- |
| EGO           | `~/.agent/ego/ego.json`                | strict JSON       | CLI / EGO                 |
| Persona       | `~/.agent/ego/persona.json`            | strict JSON       | PersonaManager            |
| Goals         | `~/.agent/ego/goals.json`              | strict JSON       | FileGoalStore             |
| Audit         | `~/.agent/ego/audit.db`                | SQLite            | SqliteAuditLog            |
| Sessions      | `<stateDir>/state/sessions.db`         | SQLite            | SessionStore              |
| Memory        | `~/.agent/memory/palace.db` + `wings/` | SQLite + Markdown | PalaceMemorySystem        |
| System prompt | `~/.agent/ego/system-prompt.md`        | Markdown          | EGO                       |
| Devices       | `<stateDir>/state/devices.json`        | JSON (mode 0o600) | DeviceAuthStore (ADR-010) |
| Trace         | `<stateDir>/trace/traces.db`           | SQLite            | SqliteTraceLog            |

경로 분리 원칙: `~/.agent/memory/` 는 메모리 시스템 전용, `~/.agent/ego/` 는 EGO 전용, `~/.agent/state/` 는 control-plane/device-auth 전용. 서로 직접 쓰지 않음.

## 8. 관측 가능성 3가지 기둥

- **Traces** — `@opentelemetry/api` 기반, `withSpan()` 헬퍼로 S1~S7 각 단계 커버. 추가로 `SqliteTraceLog` (`<stateDir>/trace/traces.db`) 가 블록-prefix (T*/G*/C*/P*/E*/W*/R*/M*/S*/K*/X\*) 로 구조화 trace 를 저장. `AGENT_TRACE=0` 비활성, `AGENT_TRACE_RETENTION_DAYS` (기본 14) 로 prune.
- **Metrics** — `InMemoryMetricsSink` (턴 수, 토큰, 비용, EGO fast-exit 비율, audit tag counts)
- **Audit logs** — SQLite 기반 `ego_audit` 테이블, 20+ 태그 (ego_decision/ego_timeout/llm_schema_mismatch/daily_cost_cap_hit/circuit_breaker_open/...)

## 9. 관련 문서

- [getting-started.md](getting-started.md) — 설치 + 첫 대화
- [configuration.md](configuration.md) — 모든 설정 파일 필드
- [tutorials/](tutorials/) — 단계별 사용 예제 (08 webapp-dashboard 포함)
- 원본 설계: [harness-engineering.md](../../claude/harness-engineering.md) (v0.7, ADR-010), [ego-design.md](../../claude/ego-design.md), [ego-persona.md](../../claude/ego-persona.md), [visualize_architecture.md](../../claude/visualize_architecture.md) (§14 Webapp 블록 다이어그램, §15 Phase-Format 공유)
