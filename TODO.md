# TODO — 구현 현황 + 미구현 항목

> 스냅샷 기준일: 2026-04-23
> 범례: ✅ 구현됨 / ⚠️ 부분·스텁 / ❌ 미구현

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
│  │                         │        │ ⚠️ chat delta 렌더 지연 버그         │  │
│  │                         │        │ ❌ gateway 자동 배선 (webappDir 수동)│  │
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
│  │ [C2'] ChannelRegistry ⚠️  ← interface만, 실제 집계 미구현              │   │
│  │ [C2''] CronRegistry    ⚠️  ← interface만, Scheduler 구현체 없음        │   │
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
│  │    ├─ planner LLM (JSON 강제 system prompt + 수동 파싱) ⚠️            │   │
│  │    │   └─ ❌ ModelAdapter 가 response_format 미노출 → JSON mode 없음  │   │
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
│  [scheduler]   ❌ CronRegistry 실구현 없음 (interface만)                      │
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
| Webapp | `packages/webapp` | ✅ (streaming 버그 ⚠️, 자동 배선 ❌) |
| 채널 5개 | `packages/channels/*` | ✅ / 일부 ⚠️ |
| Workflow | `packages/workflow` | ⚠️ |
| Device-node | `packages/device-node` | ✅ |
| **ChannelRegistry / CronRegistry / Scheduler** | — | ❌ |

---

## 미구현 · 부분구현 항목 (카테고리별 TODO)

### 운영화 공백

- [ ] webapp `/ui/*` 자동 배선 — 현재 `webappDir` 수동 주입 필요
- [ ] webapp chat delta 스트리밍 즉시 렌더 안 되는 버그 수정 (진단 중, 관련 파일에 `console.log` 잔존)
- [ ] `ChannelRegistry` 실구현 — RPC `channels.list/status` 가 현재 빈 리스트 반환
- [ ] `CronRegistry` + Scheduler 실구현 — RPC `cron.list/runNow` 빈 리스트
- [ ] `agent device {list,revoke}` CLI — `devices.json` 수동 편집만 가능
- [ ] 배포 매니페스트 (Dockerfile / docker-compose.yml / Helm chart)
- [ ] 환경 변수 관리 (dotenv 외 Vault / AWS Secrets 통합)

### ADR-009 Reasoning 잔여

- [ ] replan 트리거 #2 (LLM judge) — 비용 사유로 보류 중, 실데이터 수집 후 재평가
- [ ] replan 트리거 #3 (egoRelevance>0.8 goalUpdates) — `ReasoningContext` 로 미전달
- [ ] planner JSON 모드 — `ModelAdapter` 가 `response_format` 미노출, 현재 system prompt 유도 + 수동 파싱
- [ ] replan 보존 의미 매칭 — 현재 id 매칭만, 동일 의도 다른 id 재발행 시 중복 실행

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
- [ ] Memory access logging — 현재 `PalaceMemorySystem.search()` 스텁

### 문서화

- [ ] 사용자 가이드 — CLI 사용법, 설정 파일 스키마, 튜토리얼 확충
- [ ] 아키텍처 다이어그램 — 실 구현 기준 업데이트 (현 설계문서는 스펙 기준)
- [ ] API 레퍼런스 — 공개 `contracts.*` 인터페이스별 문서
