# TODO — 구현 현황 + 미구현 항목

> 스냅샷 기준일: 2026-04-24 (진행 상황 업데이트 포함)
> 범례: ✅ 구현됨 / ⚠️ 부분·스텁 / ❌ 미구현 / 🟢 이 세션에서 처리됨

## 이 세션 진행 사항

- 🟢 **#1 webapp `/ui/*` 자동 배선** — `agent gateway start` 가 `--webapp-dir` → `AGENT_WEBAPP_DIR` → `packages/webapp/dist` 자동 탐지 순으로 resolve. `--no-webapp` 으로 opt-out. 시작 배너에 ui 라인 추가. 커밋 `009e54a`.
- 🟢 **#2 webapp chat delta 스트리밍** — `.innerHTML` 프로퍼티 바인딩을 Lit `unsafeHTML` 디렉티브로 교체, 진단용 `console.log` 4곳(`chat-bubble` / `chat-transcript` / `view-chat` / `chat-controller`) 제거. 커밋 `e656b2f`. **주의**: 브라우저 실렌더 검증은 사용자 환경에서 아직 미확인.
- 🟢 **#3 `agent device {list,revoke}` CLI** — `packages/cli/src/commands/device.ts` 신규; `device list [--json]` 테이블/JSON 두 형식, `device revoke <deviceId>` 즉시 무효화. `DeviceAuthStore` 직접 사용 (gateway 실행 불필요, devices.json 만 읽음). 커밋 `6e728ac`.
- 🟢 **#4 replan 트리거 #3 (egoRelevance>0.8 + goalUpdates)** — EGO `cognition` + `goalUpdates` 를 metadata → `ReasoningContext.egoCognition/goalUpdates` 로 전달. `PlanExecuteExecutor` 가 초기 plan 생성 직후 조건 충족 시 재계획 1회 발화 (reason=`goal_updates_high_relevance`, `replanLimit` 공유). 단위 테스트 5건 신규 추가, 전체 agent-worker suite 116 tests green. 커밋 `c88aba0`.
- 🟢 **#5 ChannelRegistry 구현 (option a)** — `PlatformChannelRegistry` 신규 (`packages/control-plane/src/gateway/`). register/deregister + recordEvent/recordError/updateSessionCount/refreshHealth. platform.ts 가 WebChat 부팅 시 등록, onMessage/catch 에서 이벤트·에러 피드. `channels.list/status` RPC 가 실 데이터 반환. 단위 테스트 9건. 커밋 `a93b65a`.
- 🟢 **#6 Scheduler / CronRegistry 구현 (option B)** — `packages/scheduler/` 신규 (node-cron + workflow deps). CronTask discriminated union (chat/bash/workflow) + TaskRunner 인터페이스. ChatTaskRunner 는 platform handler 직접 호출 (EGO 자동 경유), BashTaskRunner 는 ToolSandbox + ownerPolicy 경유, WorkflowTaskRunner 는 executeWorkflow 래핑. tasks.json JSON5 스타일, 단일동시성 (in-flight 는 skip/runNow 거절), log-and-continue. `cron.list/runNow` RPC 가 실 데이터 반환. 단위 테스트 22건. 커밋 `d05a7c0`.
- 🟢 **#7 planner JSON 모드** — `agent-worker/CompletionRequest` 에 `responseFormat?: { type: 'json_object' \| 'text' }` 추가. OpenAI 어댑터는 native `response_format` 패스스루, Anthropic 은 assistant `{` prefill + 첫 text_delta 에 `{` prepend 로 prompt-only 회귀 위험 제거. `PlanExecuteExecutor` 의 3개 planner 사이트 모두 json_object 요청 (합성은 텍스트 유지). 단위 테스트 10건 (anthropic 4 + openai 3 + plan-execute 3), agent-worker suite 143/143 green.

---

## 전체 시스템 블록 다이어그램

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        직접 운영자 서피스 (Direct Operators)                   │
│  ┌─────────────────────────┐        ┌─────────────────────────────────────┐  │
│  │ TUI  (Ink + React) ✅   │        │ Webapp  (Vite + Lit 3) ✅            │  │
│  │ T1 InputBar ✅          │        │ app-root / <phase-line> /            │  │
│  │ T2 App ✅               │        │ 6 views(chat/overview/channels/      │  │
│  │ T3 RpcClient ✅         │        │   instances/sessions/cron) ✅        │  │
│  │ Bearer master 토큰      │        │ ed25519 IndexedDB + HMAC 세션 ✅     │  │
│  │                         │        │ 🟢 chat delta 렌더 (unsafeHTML 패치) │  │
│  │                         │        │    ⚠️ 브라우저 실검증 대기            │  │
│  │                         │        │ 🟢 gateway 자동 배선 (auto-detect)  │  │
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
│  │  ├─ /healthz ✅  /messages ✅  /ws ✅ (webchat 채널)                    │   │
│  │  ├─ /rpc (WS) ── mount hook for gateway-cli ✅                         │   │
│  │  ├─ /device/enroll · /challenge · /assert ✅  (ADR-010)               │   │
│  │  ├─ /ui/* (SPA 정적 서빙) ✅ (webappDir 제공 시)                       │   │
│  │  ├─ TokenAuth + secondary verifier(master + device) ✅                 │   │
│  │  └─ RateLimiter ✅                                                     │   │
│  │                                                                        │   │
│  │ [G2] RpcServer (JSON-RPC 2.0) ✅                                       │   │
│  │ [G3] chat.send / history / abort 핸들러 ✅                             │   │
│  │                                                                        │   │
│  │ DeviceAuthStore ✅  devices.json 0o600  (ADR-010)                     │   │
│  │  └─ ❌ `agent device {list,revoke}` CLI — 수동 편집만 가능             │   │
│  │                                                                        │   │
│  │ [C1] RuleRouter ✅       [C2] SessionStore (sessions.db) ✅            │   │
│  │ [C2'] ChannelRegistry ✅  (PlatformChannelRegistry, WebChat 등록 중)   │   │
│  │ [C2''] CronRegistry    ✅  (SchedulerService, 3 runner: chat/bash/wf) │   │
│  └───────────────────────────┬────────────────────────────────────────────┘   │
└──────────────────────────────┼────────────────────────────────────────────────┘
                               │
┌──────────────────────────────┼────────────────────────────────────────────────┐
│              Platform Handler (packages/cli runtime) ✅                        │
│  [P1] startPlatform() — 모든 컴포넌트 lazy 배선                                 │
│       ├─ SessionStore, Router, EgoLayer, AgentRunner, Memory, Sandbox ✅       │
│       ├─ HybridReasoner 기본 주입 (tools 있으면 plan-execute 자동) ✅          │
│       ├─ DeviceAuthStore 자동 초기화 ✅                                        │
│       └─ webappDir 주입 ⚠️ (수동; 자동 탐지 ❌)                                │
└──────────────────────────────┬────────────────────────────────────────────────┘
                               │
                        ┌──────▼──────┐
                        │  EGO ON?    │───── off ─────────────────┐
                        └──────┬──────┘                           │
                      passive  │ active                           │
                               ▼                                  │
┌────────────────────────────────────────────────────────────────┼────────────┐
│            [E1] EgoLayer  (packages/ego) ✅ (ADR-005/006)      │            │
│  S1 Intake → S2 Normalize (규칙 ~16ms, ~75% passthrough 목표)✅│            │
│  shouldFastExit? ─── true → passthrough                        │            │
│  ↓ false                                                       │            │
│  gatherContext (memory + goals + recent turns, 병렬) ✅        │            │
│  buildSystemPrompt (persona snapshot 주입) ✅                  │            │
│  EgoLlmAdapter.think → Claude Haiku JSON ✅                    │            │
│  validateEgoThinking → 스키마 + 의미 일관성 ✅                 │            │
│  materialize → passthrough/enrich/redirect/direct_response ✅  │            │
│  ── CircuitBreaker ✅  · daily cost cap auto-downgrade ✅      │            │
│  ── SqliteAuditLog ✅ (20+ 태그)                               │            │
│  ── FileGoalStore ✅ (ADR-007)                                 │            │
│  ── FilePersonaManager + evolution rules ✅                    │            │
│  ❌ ADR-005 범위 밖: 멀티에이전트 위임 프로토콜                │            │
└──────────────────────────────┬─────────────────────────────────┼────────────┘
                               │ invoke                          │
                               ▼          ◄────────── bypass ────┘
┌─────────────────────────────────────────────────────────────────────────────┐
│            [W1] AgentRunner.processTurn (packages/agent-worker) ✅           │
│                                                                              │
│  [W2] PromptBuilder (EGO enrichment 주입) ✅                                 │
│  [M*] ModelAdapter: Anthropic SDK 0.88 ✅  ·  OpenAI ✅                      │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ [R*] Reasoning 레이어 (ADR-009) ✅                                    │   │
│  │                                                                      │   │
│  │  [R1] HybridReasoner ✅                                               │   │
│  │    └─ [R1a] ComplexityRouter ✅                                       │   │
│  │         (EGO perception 직접 입력 — U8)                              │   │
│  │         low → ReAct   medium|high → Plan-Execute                     │   │
│  │         workflow_execution → 강제 plan-execute                       │   │
│  │                                                                      │   │
│  │  [R2] ReactExecutor  ✅  (Thought/Action/Observation, 2 retry)       │   │
│  │                                                                      │   │
│  │  [R3] PlanExecuteExecutor  ✅                                         │   │
│  │    ├─ planner LLM (JSON mode: OpenAI native / Anthropic prefill) ✅   │   │
│  │    ├─ replan 트리거 #1 (stepRetry 소진) ✅                            │   │
│  │    ├─ ❌ replan 트리거 #2 (LLM judge — 비용 사유 보류)                │   │
│  │    ├─ ❌ replan 트리거 #3 (egoRelevance>0.8 goalUpdates — 미전달)     │   │
│  │    ├─ 병렬 실행 (parallelExecution opt-in, 레벨 기반) ✅              │   │
│  │    ├─ replan 성공 단계 id 승계 보존 ✅                                │   │
│  │    │   └─ ⚠️ 의미 매칭은 미지원 (동일 의도/다른 id 시 중복 실행)      │   │
│  │    └─ 한도 초과 시 ReAct 다운그레이드 ✅                              │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  [K*] LiveToolRegistry + LocalSkillRegistry ✅                               │
│       built-in: fsRead/fsWrite/webFetch/bashTool ✅ (buildDefaultTools)      │
│       signed skill bundle: architecture-lookup / trace-lookup ✅             │
│       ❌ Skill sandbox 격리 (현재 host process 실행)                         │
│                                                                              │
│  [S*] Sandbox + CapabilityGuard ✅                                           │
│       InProcessSandbox ✅   DockerSandbox ⚠️ (spawn 기반, gVisor 미검증)     │
│       PolicyCapabilityGuard ✅  ⚠️ single-owner policy (멀티테넌트 아님)     │
└──┬──────────────────┬─────────────────────┬────────────────────────────────┘
   │                  │                     │
┌──▼─────────┐  ┌─────▼─────────┐  ┌────────▼────────────┐
│ [X*] Memory│  │  Observability│  │  Message Bus        │
│ PalaceMem✅│  │  OTel tracer✅ │  │  InProcessBus ✅    │
│ FTS5 ✅    │  │  Metrics   ✅ │  │  RedisStreamsBus ✅ │
│ cosine ✅  │  │  OTLP      ✅ │  │  ⚠️ worker pool 경유 │
│ ⚠️in-mem   │  │  Audit DB  ✅ │  │     분리형 배포 미구현│
│   (vec-ext │  │  TraceLog  ✅ │  │     (현재는 직접 호출)│
│   교체 옵션)│  └───────────────┘  └─────────────────────┘
│ ⚠️access   │
│   logging  │
│   스텁     │
└────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│             채널 어댑터 계층 (Contracts.ChannelAdapter) ✅                    │
│  ┌─────────┐ ┌──────────┐ ┌────────┐ ┌─────────────┐ ┌──────────────────┐   │
│  │ WebChat │ │ Telegram │ │ Slack  │ │ Discord     │ │ WhatsApp          │   │
│  │ WS ✅   │ │ 롱폴링 ✅ │ │Events ✅│ │ Gateway WS✅│ │ baileys ⚠️ QR     │   │
│  │         │ │           │ │         │ │⚠️ 단일 샤드 │ │  실 페어링 미검증 │   │
│  │         │ │           │ │         │ │❌ Resume    │ │❌ Cloud API 대안 │   │
│  │         │ │           │ │⚠️Socket │ │   gap복구   │ │                  │   │
│  │         │ │           │ │  Mode ❌│ │             │ │                  │   │
│  └─────────┘ └──────────┘ └────────┘ └─────────────┘ └──────────────────┘   │
│  ❌ ChannelRegistry — 위 어댑터들을 RPC 로 집계 노출하는 와이어링 미구현      │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                  곁가지 패키지 (보조 · 실행기)                                │
│  [device-node] WS 프로토콜(페어링/하트비트/푸시) ✅                           │
│  [workflow]    선언적 DSL 인터프리터 ✅  ⚠️ 함수·에러핸들러 없음              │
│  [scheduler]   ✅ node-cron + chat/bash/workflow runner, tasks.json          │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 패키지 ↔ 블록 매핑 (요약)

| 블록 | 패키지 | 구현 |
|---|---|---|
| T1-T3 | `packages/tui` | ✅ |
| G1 / C1-C2 / DeviceAuth | `packages/control-plane` | ✅ |
| G2-G3 + RPC 메서드 | `packages/gateway-cli` | ✅ |
| P1 | `packages/cli/src/runtime/platform.ts` | ✅ (webappDir 자동 ❌) |
| E1 전체 | `packages/ego` | ✅ |
| W1-W2 / M* | `packages/agent-worker/{runner,prompt,model}` | ✅ |
| R1-R3 | `packages/agent-worker/src/reasoning` | ✅ (트리거 #2/#3 ❌) |
| K* | `packages/skills` + `packages/agent-worker/src/tools` | ✅ (Skill sandbox 격리 ❌) |
| S* | `packages/agent-worker/src/security + tools/*sandbox.ts` | ✅ / ⚠️ |
| X* Memory | `packages/memory` | ✅ (vec-ext 교체 옵션 ⚠️) |
| X* Observability | `packages/observability` | ✅ |
| Message Bus | `packages/message-bus` | ✅ (worker-pool 배포 ❌) |
| Webapp | `packages/webapp` | ✅ (streaming 🟢 unsafeHTML 패치·브라우저 검증 대기, 자동 배선 🟢) |
| 채널 5개 | `packages/channels/*` | ✅ / 일부 ⚠️ |
| Workflow | `packages/workflow` | ⚠️ |
| Device-node | `packages/device-node` | ✅ |
| ChannelRegistry | `packages/control-plane/src/gateway/platform-channel-registry.ts` | ✅ |
| Scheduler / CronRegistry | `packages/scheduler` | ✅ |

---

## 미구현 · 부분구현 항목 (카테고리별 TODO)

### 운영화 공백

- [x] ~~webapp `/ui/*` 자동 배선~~ — 🟢 완료 (커밋 `009e54a`). `agent gateway start` 가 `--webapp-dir` → `AGENT_WEBAPP_DIR` → `packages/webapp/dist` 자동 탐지 순으로 resolve
- [x] ~~webapp chat delta 스트리밍 즉시 렌더 안 되는 버그 수정~~ — 🟢 코드 변경 적용 (커밋 `e656b2f`). `.innerHTML` → Lit `unsafeHTML` 디렉티브, 진단용 `console.log` 제거. **브라우저 실렌더 검증 필요** (제 환경에서 브라우저 실행 불가 — 사용자 환경에서 확인 요망)
- [x] ~~`ChannelRegistry` 실구현~~ — 🟢 option (a) 완료 (커밋 `a93b65a`). `PlatformChannelRegistry` in `packages/control-plane/src/gateway/platform-channel-registry.ts`. 이벤트/에러 기반 status 파생 + `refreshHealth(id)` 온디맨드. 현재 WebChat 1개 등록; Telegram/Slack/Discord/WhatsApp 은 platform 기동 로직이 생기면 동일 패턴으로 register 한 줄씩 추가
- [x] ~~`CronRegistry` + Scheduler 실구현~~ — 🟢 option B 완료 (커밋 `d05a7c0`). `packages/scheduler/` 신규. 3 runner (chat/bash/workflow), node-cron 스케줄, tasks.json JSON5. v1 스코프: RPC mutation 없음 (재시작으로 반영), 실행 이력 인메모리, log-and-continue 실패 정책
- [x] ~~`agent device {list,revoke}` CLI~~ — 🟢 완료. `packages/cli/src/commands/device.ts`; `list` 는 `deviceId · name · enrolledAt · lastSeenAt` 테이블 (또는 `--json`), `revoke <id>` 는 즉시 삭제 + 세션 토큰 무효화 (기존 토큰은 `verifySessionToken` 에서 `device revoked` 로 거절)
- [ ] 배포 매니페스트 — 타깃 결정 필요: Docker compose / Kubernetes / Helm 중 어느 것(들)?
- [ ] 환경 변수 관리 — 타깃 결정 필요: Vault / AWS Secrets Manager / GCP Secret Manager / SOPS / dotenv 만 중 어느 것?

### ADR-009 Reasoning 잔여

- [ ] replan 트리거 #2 (LLM judge) — 비용 사유로 보류 중, 실데이터 수집 후 재평가
- [x] ~~replan 트리거 #3 (egoRelevance>0.8 goalUpdates)~~ — 🟢 완료. `ReasoningContext` 에 `egoCognition` + `goalUpdates` 필드 추가, `platform.ts` 가 metadata `_egoCognition`/`_egoGoalUpdates` 로 전달, `PlanExecuteExecutor` 가 초기 plan 직후 1회 재계획 (`goal_updates_high_relevance`). `replanLimit` 공유로 트리거 #1 과 합쳐도 상한 초과 없음
- [x] ~~planner JSON 모드~~ — 🟢 완료. `agent-worker/CompletionRequest` 에 `responseFormat?: { type: 'json_object' \| 'text' }` 추가. OpenAI 어댑터는 native `response_format: { type: 'json_object' }` 패스스루, Anthropic 어댑터는 assistant prefill `{` 를 messages 끝에 부착하고 첫 `text_delta` 에 `{` 를 prepend 해 caller 가 `JSON.parse()` 그대로 가능. `PlanExecuteExecutor` 의 3개 planner 호출 사이트(`callPlanner` 초기·재계획 / `applyGoalUpdateReplan`) 가 모두 json_object 요청, 합성(`synthesizeFinal`) 은 텍스트 유지. 단위 테스트 10건 신규 (anthropic 4 + openai 3 + plan-execute 3)
- [x] ~~replan 보존 의미 매칭~~ — 🟢 완료 (커밋 `672fd31`). `StepMatcher` 인터페이스 + `EmbedderStepMatcher` 기본 구현 (threshold 0.85). `preservePriorSuccesses()` 헬퍼가 id-match 우선 + 의미 fallback. `HybridReasonerDeps.stepMatcher` 로 주입, platform.ts 가 palace 의 `embedder.embed` 공유. matcher 미주입 시 pre-v0.7 id-only 동작 유지

### 멀티에이전트 / 분산

- [ ] 에이전트 위임 프로토콜 — 한 에이전트 → 다른 에이전트 서브태스크 (별도 ADR 필요)
- [ ] Message bus 경유 worker pool — 현재는 직접 호출, ADR-001 분리형 배포 여지만 확보
- [ ] `PolicyCapabilityGuard` per-session 분리 — 현재 `__default__` 단일 policy (멀티테넌트 필요 시)

### 보안 · 샌드박스

- [ ] Skill 실행 sandbox 격리 — 현재 host process 에서 실행
- [ ] DockerSandbox gVisor 런타임 실 검증 — 옵션은 있으나 미검증
- [ ] 보안 감사 — 프롬프트 인젝션, 토큰 탈취, 샌드박스 탈출 시나리오

### 채널 디테일

- [ ] Discord Gateway Resume (gap sequence 복구) / sharding
- [ ] Slack Socket Mode — 현재 Events API webhook
- [ ] WhatsApp Cloud API 대안 — 현재 baileys 만
- [ ] Baileys QR 페어링 실 디바이스 검증

### 스펙 정리

- [ ] ADR-010 (device-identity 인증) `harness-engineering.md` 공식 ADR 로 승급 — 현재 구현만 존재

### 테스트 · 품질

- [ ] 로드 테스트 — 동시 세션 N개, turn throughput 측정
- [ ] Chaos 테스트 — Redis 장애, LLM 타임아웃, DB 잠금
- [ ] 실 서비스 e2e — Telegram 봇 토큰 왕복, Anthropic API 비용 측정, OTel → Jaeger/Tempo 파이프라인 검증

### 기능 확장

- [ ] Workflow 엔진 개선 — 함수 정의/호출, 에러 핸들러, 중첩 변수 스코프
- [x] ~~Memory access logging~~ — 🟢 완료 (커밋 `d2d8d89`). `hybridSearchDetailed` 가 chunkId 반환 → `PalaceMemorySystem.search()` 가 `MemoryChunkStore.recordAccess()` 호출. `AGENT_MEMORY_ACCESS_LOG` 환경변수 토글 (기본 on, `=0` off). `memory_access_log` 스키마는 pre-existing, 이전 stub 은 placeholder 였음

### 문서화

- [ ] 사용자 가이드 — CLI 사용법, 설정 파일 스키마, 튜토리얼 확충
- [ ] 아키텍처 다이어그램 — 실 구현 기준 업데이트 (현 설계문서는 스펙 기준)
- [ ] API 레퍼런스 — 공개 `contracts.*` 인터페이스별 문서
