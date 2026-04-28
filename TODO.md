# TODO — 구현 현황 + 미구현 항목

> 스냅샷 기준일: 2026-04-28
> 범례: ✅ 구현됨 / ⚠️ 부분·스텁 / ❌ 미구현

---

## 남은 할일 — 즉시 코드 작업 가능

블로킹 의사결정 없이 단독 코드 변경으로 끝낼 수 있는 항목들.

### 보안 · 샌드박스
- [ ] **Skill 실행 sandbox 격리** — 현재 host process 에서 실행. 옵션: (a) DockerSandbox 재사용, (b) Node `vm` 모듈 격리, (c) child_process. (a) 가 보안 강도 가장 높음
- [ ] **DockerSandbox gVisor 런타임 실 검증** — 코드 옵션은 있으나 실 환경에서 `runsc` 동작·성능 미측정
- [ ] **보안 감사** — 프롬프트 인젝션 / 토큰 탈취 / 샌드박스 탈출 시나리오 코드 리뷰 + 테스트 케이스 추가

### 채널 어댑터 보강
- [ ] **Discord Gateway Resume** (gap sequence 복구) / sharding — 현재 단일 샤드, 연결 끊김 시 메시지 누락 가능
- [ ] **Slack Socket Mode** — 현재 Events API webhook 만, Socket Mode 어댑터 부재
- [ ] **WhatsApp Cloud API 대안** — 현재 baileys 만, Meta 공식 Cloud API 어댑터 부재

### 스펙·문서
- [ ] **ADR-010 (device-identity) 공식 ADR 로 승급** — 구현은 있으나 `harness-engineering.md` 에 ADR-010 본문 누락
- [ ] **사용자 가이드** — CLI 사용법 / 설정 파일 스키마 / 튜토리얼
- [ ] **아키텍처 다이어그램 (실 구현 기준)** — 현 설계문서는 스펙 기준이라 실제와 약간 어긋남
- [ ] **API 레퍼런스** — 공개 `contracts.*` 인터페이스별 문서

---

## 남은 할일 — 결정·합의 필요

코드는 가능하나 방향 합의가 선행돼야 하는 항목들.

- [ ] **배포 매니페스트** — 타깃 결정 필요: Docker compose / Kubernetes / Helm 중 어느 것(들)?
- [ ] **환경 변수 관리** — 타깃 결정 필요: Vault / AWS Secrets Manager / GCP Secret Manager / SOPS / dotenv 만 중 어느 것?
- [ ] **에이전트 위임 프로토콜** — 한 에이전트 → 다른 에이전트 서브태스크. 별도 ADR 필요 (현재 ADR-005 범위 밖)
- [ ] **Message bus 경유 worker pool** — 현재 직접 호출, ADR-001 분리형 배포 여지만 확보. 실제 분리 시점·트리거 미정
- [ ] **`PolicyCapabilityGuard` per-session 분리** — 현재 `__default__` 단일 policy. 멀티테넌트 요구 시점에 결정
- [ ] **replan 트리거 #2 (LLM judge)** — 비용 사유로 보류. 실데이터 수집 후 재평가

---

## 남은 할일 — 외부 환경 검증·테스트 인프라

런타임·실 서비스 접근 또는 장기 테스트 인프라가 필요한 항목들.

- [ ] **webapp chat delta 브라우저 실렌더 검증** — 코드 변경(unsafeHTML 패치) 머지됨, 사용자 환경에서 실 브라우저 구동 검증 대기
- [ ] **Baileys QR 페어링 실 디바이스 검증** — 코드는 있으나 실 디바이스에서 QR 스캔·세션 유지 미검증
- [ ] **로드 테스트** — 동시 세션 N개, turn throughput 측정 (k6 / artillery 추정)
- [ ] **Chaos 테스트** — Redis 장애 / LLM 타임아웃 / DB 잠금 시 회복
- [ ] **실 서비스 e2e** — Telegram 봇 토큰 왕복 / Anthropic API 비용 측정 / OTel → Jaeger·Tempo 파이프라인 검증

---

## 시스템 블록 다이어그램 (현재 상태)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        직접 운영자 서피스 (Direct Operators)                   │
│  ┌─────────────────────────┐        ┌─────────────────────────────────────┐  │
│  │ TUI  (Ink + React) ✅   │        │ Webapp  (Vite + Lit 3) ✅            │  │
│  │ T1 InputBar ✅          │        │ app-root / <phase-line> /            │  │
│  │ T2 App ✅               │        │ 6 views(chat/overview/channels/      │  │
│  │ T3 RpcClient ✅         │        │   instances/sessions/cron) ✅        │  │
│  │ Bearer master 토큰      │        │ ed25519 IndexedDB + HMAC 세션 ✅     │  │
│  │                         │        │ chat delta 렌더 (unsafeHTML) ✅      │  │
│  │                         │        │   ⚠️ 브라우저 실검증 사용자 환경 대기 │  │
│  │                         │        │ /ui/* SPA 자동 배선 ✅               │  │
│  └──────────────┬──────────┘        └───────────────┬─────────────────────┘  │
│                 │ Authorization: Bearer …           │ Sec-WebSocket-Protocol:│
│                 │                                   │ bearer.<sessionToken>  │
│                 └──────────────┬────────────────────┘                        │
│                                │ JSON-RPC 2.0 over WebSocket /rpc            │
│                                ▼ (chat.*, sessions.*, overview.status,       │
│                                   channels.*, instances.*, cron.*,           │
│                                   gateway.*, chat.phase notification)        │
└────────────────────────────────┼─────────────────────────────────────────────┘
                                 │
┌────────────────────────────────┼─────────────────────────────────────────────┐
│                  Gateway / Control-Plane 레이어                               │
│  ┌─────────────────────────────▼─────────────────────────────────────────┐   │
│  │ [G1] ApiGateway (HTTP + WS)  ✅                                        │   │
│  │  ├─ /healthz · /messages · /ws (webchat) ✅                            │   │
│  │  ├─ /rpc (WS) ── mount hook for gateway-cli ✅                         │   │
│  │  ├─ /device/enroll · /challenge · /assert ✅  (ADR-010)               │   │
│  │  ├─ /ui/* (SPA 정적 서빙) ✅                                           │   │
│  │  ├─ TokenAuth + master/device verifier ✅                              │   │
│  │  └─ RateLimiter ✅                                                     │   │
│  │                                                                        │   │
│  │ [G2] RpcServer (JSON-RPC 2.0) ✅                                       │   │
│  │ [G3] chat.send/history/abort 핸들러 ✅                                 │   │
│  │                                                                        │   │
│  │ DeviceAuthStore ✅  devices.json 0o600  (ADR-010)                     │   │
│  │  └─ `agent device {list,revoke}` CLI ✅                                │   │
│  │                                                                        │   │
│  │ [C1] RuleRouter ✅       [C2] SessionStore (sessions.db) ✅            │   │
│  │ [C2'] ChannelRegistry ✅  PlatformChannelRegistry — 이벤트 집계 +      │   │
│  │                            channels.list/status RPC 백엔드             │   │
│  │ [C2''] CronRegistry ✅   SchedulerService — 3 runner (chat/bash/wf),  │   │
│  │                            tasks.json JSON5, cron.list/runNow RPC     │   │
│  └───────────────────────────┬────────────────────────────────────────────┘   │
└──────────────────────────────┼────────────────────────────────────────────────┘
                               │
┌──────────────────────────────┼────────────────────────────────────────────────┐
│              Platform Handler (packages/cli runtime) ✅                        │
│  [P1] startPlatform() — 모든 컴포넌트 lazy 배선                                 │
│       ├─ SessionStore, Router, EgoLayer, AgentRunner, Memory, Sandbox ✅       │
│       ├─ HybridReasoner 기본 주입 (tools 있으면 plan-execute 자동) ✅          │
│       ├─ DeviceAuthStore 자동 초기화 ✅                                        │
│       └─ webappDir 자동 탐지 ✅ (--webapp-dir → env → packages/webapp/dist)   │
└──────────────────────────────┬────────────────────────────────────────────────┘
                               │
                        ┌──────▼──────┐
                        │  EGO ON?    │───── off ─────────────────┐
                        └──────┬──────┘                           │
                      passive  │ active                           │
                               ▼                                  │
┌────────────────────────────────────────────────────────────────┼────────────┐
│            [E1] EgoLayer  (packages/ego) ✅ (ADR-005/006)      │            │
│  S1 Intake → S2 Normalize (규칙 ~16ms, ~75% passthrough 목표)  │            │
│  shouldFastExit? → passthrough                                 │            │
│  gatherContext (memory + goals + recent turns, 병렬) ✅        │            │
│  buildSystemPrompt (persona snapshot 주입) ✅                  │            │
│  EgoLlmAdapter.think → Claude Haiku JSON ✅                    │            │
│  validateEgoThinking → 스키마 + 의미 일관성 ✅                 │            │
│  materialize → passthrough/enrich/redirect/direct_response ✅  │            │
│  CircuitBreaker ✅  · daily cost cap auto-downgrade ✅         │            │
│  SqliteAuditLog ✅ (20+ 태그)                                  │            │
│  FileGoalStore ✅ (ADR-007) · FilePersonaManager + evolution ✅│            │
│  ❌ 멀티에이전트 위임 프로토콜 (ADR-005 범위 밖)               │            │
└──────────────────────────────┬─────────────────────────────────┼────────────┘
                               │ invoke                          │
                               ▼          ◄────────── bypass ────┘
┌─────────────────────────────────────────────────────────────────────────────┐
│            [W1] AgentRunner.processTurn (packages/agent-worker) ✅           │
│                                                                              │
│  [W2] PromptBuilder (EGO enrichment 주입) ✅                                 │
│  [M*] ModelAdapter: Anthropic SDK 0.88 ✅  ·  OpenAI ✅                      │
│       responseFormat='json_object' 지원 (OpenAI native / Anthropic prefill) │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ [R*] Reasoning 레이어 (ADR-009) ✅                                    │   │
│  │                                                                      │   │
│  │  [R1] HybridReasoner ✅                                               │   │
│  │    └─ [R1a] ComplexityRouter ✅ (EGO perception 직접 입력)            │   │
│  │         low → ReAct   medium|high → Plan-Execute                     │   │
│  │         workflow_execution → 강제 plan-execute                       │   │
│  │                                                                      │   │
│  │  [R2] ReactExecutor  ✅ (Thought/Action/Observation, 2 retry)        │   │
│  │                                                                      │   │
│  │  [R3] PlanExecuteExecutor  ✅                                         │   │
│  │    ├─ planner LLM JSON 모드 (provider 별 강제) ✅                     │   │
│  │    ├─ replan 트리거 #1 (stepRetry 소진) ✅                            │   │
│  │    ├─ ❌ replan 트리거 #2 (LLM judge — 비용 사유 보류)                │   │
│  │    ├─ replan 트리거 #3 (egoRelevance>0.8 + goalUpdates) ✅            │   │
│  │    ├─ 병렬 실행 (parallelExecution opt-in, 레벨 기반) ✅              │   │
│  │    ├─ replan 단계 보존: id 매칭 + StepMatcher 의미 fallback ✅        │   │
│  │    └─ 한도 초과 시 ReAct 다운그레이드 ✅                              │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  [K*] LiveToolRegistry + LocalSkillRegistry ✅                               │
│       built-in: fsRead/fsWrite/webFetch/bashTool ✅ (buildDefaultTools)      │
│       signed skill bundle: architecture-lookup / trace-lookup ✅             │
│       ❌ Skill 실행 sandbox 격리 (현재 host process)                         │
│                                                                              │
│  [S*] Sandbox + CapabilityGuard ✅                                           │
│       InProcessSandbox ✅   DockerSandbox ⚠️ (gVisor 미검증)                │
│       PolicyCapabilityGuard ✅  (single-owner — 멀티테넌트 시 분리 필요)     │
└──┬──────────────────┬─────────────────────┬────────────────────────────────┘
   │                  │                     │
┌──▼─────────┐  ┌─────▼─────────┐  ┌────────▼────────────┐
│ [X*] Memory│  │  Observability│  │  Message Bus        │
│ PalaceMem✅│  │  OTel tracer✅ │  │  InProcessBus ✅    │
│ FTS5 ✅    │  │  Metrics   ✅ │  │  RedisStreamsBus ✅ │
│ cosine ✅  │  │  OTLP      ✅ │  │  ⚠️ worker pool 경유 │
│ access log✅│  │  Audit DB  ✅ │  │     분리형 배포 미구현│
│ ⚠️in-mem   │  │  TraceLog  ✅ │  │     (현재는 직접 호출)│
│   (vec-ext │  └───────────────┘  └─────────────────────┘
│   교체 옵션)│
└────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│             채널 어댑터 계층 (Contracts.ChannelAdapter) ✅                    │
│  ┌─────────┐ ┌──────────┐ ┌────────┐ ┌─────────────┐ ┌──────────────────┐   │
│  │ WebChat │ │ Telegram │ │ Slack  │ │ Discord     │ │ WhatsApp          │   │
│  │ WS ✅   │ │ 롱폴링 ✅ │ │Events ✅│ │ Gateway WS✅│ │ baileys ⚠️ QR     │   │
│  │         │ │           │ │ ❌     │ │⚠️ 단일 샤드 │ │  실 페어링 미검증 │   │
│  │         │ │           │ │ Socket │ │❌ Resume    │ │❌ Cloud API 대안 │   │
│  │         │ │           │ │ Mode   │ │   gap 복구  │ │                  │   │
│  └─────────┘ └──────────┘ └────────┘ └─────────────┘ └──────────────────┘   │
│  ChannelRegistry ✅ — PlatformChannelRegistry 가 어댑터 이벤트/에러 집계      │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                  곁가지 패키지 (보조 · 실행기)                                │
│  [device-node] WS 프로토콜(페어링/하트비트/푸시) ✅                           │
│  [workflow]    선언적 DSL 인터프리터 ✅  (call/return/try/catch/scope 포함)   │
│  [scheduler]   ✅ node-cron + chat/bash/workflow runner, tasks.json          │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 패키지 ↔ 블록 매핑 (요약)

| 블록 | 패키지 | 구현 |
|---|---|---|
| T1-T3 | `packages/tui` | ✅ |
| G1 / C1-C2 / DeviceAuth | `packages/control-plane` | ✅ |
| G2-G3 + RPC 메서드 | `packages/gateway-cli` | ✅ |
| P1 | `packages/cli/src/runtime/platform.ts` | ✅ |
| E1 전체 | `packages/ego` | ✅ |
| W1-W2 / M* | `packages/agent-worker/{runner,prompt,model}` | ✅ |
| R1-R3 | `packages/agent-worker/src/reasoning` | ✅ (트리거 #2 보류) |
| K* | `packages/skills` + `packages/agent-worker/src/tools` | ✅ (Skill sandbox 격리 ❌) |
| S* | `packages/agent-worker/src/security + tools/*sandbox.ts` | ✅ / ⚠️ (gVisor 미검증) |
| X* Memory | `packages/memory` | ✅ (vec-ext 교체 옵션 ⚠️) |
| X* Observability | `packages/observability` | ✅ |
| Message Bus | `packages/message-bus` | ✅ (worker-pool 배포 ❌) |
| Webapp | `packages/webapp` | ✅ (브라우저 실검증 ⚠️) |
| 채널 5개 | `packages/channels/*` | ✅ / 일부 ⚠️ |
| ChannelRegistry | `packages/control-plane/src/gateway/platform-channel-registry.ts` | ✅ |
| Scheduler / CronRegistry | `packages/scheduler` | ✅ |
| Workflow | `packages/workflow` | ✅ |
| Device-node | `packages/device-node` | ✅ |

---

## 최근 완료 (커밋 ledger)

git log 보조용 — 상세 내역은 커밋 메시지 참조.

| 커밋 | 항목 |
|---|---|
| `51bf250` | workflow: functions / try-catch-finally / scope (call·return·try·scope step kinds, scope frame stack, depth limit) |
| `f8a7b5c` | agent-worker: planner JSON mode (OpenAI native + Anthropic `{` prefill, 3 planner sites) |
| `0c99c2d` | docs: memory access logging + replan semantic matching 완료 표시 |
| `672fd31` | agent-worker+cli: replan 단계 보존 의미 매칭 (StepMatcher + EmbedderStepMatcher, threshold 0.85) |
| `d2d8d89` | memory: PalaceMemorySystem.search() access logging (`AGENT_MEMORY_ACCESS_LOG` 토글) |
| `765ea5c` | skills: architecture-lookup 번들 v0.7.0 갱신 |
| `d05a7c0` | scheduler+cli: CronRegistry — chat/bash/workflow runner, tasks.json JSON5 |
| `a93b65a` | control-plane+cli: PlatformChannelRegistry → channels.list/status RPC 백엔드 |
| `c88aba0` | agent-worker+core: replan 트리거 #3 (egoRelevance + goalUpdates) |
| `6e728ac` | cli: `agent device {list,revoke}` |
| `e656b2f` | webapp: chat delta 렌더 (`.innerHTML` → Lit `unsafeHTML`) |
| `009e54a` | gateway: webapp `/ui/*` 자동 배선 (`--webapp-dir` → env → dist) |
