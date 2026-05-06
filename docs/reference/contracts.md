# Contracts API Reference

`@agent-platform/core/contracts` 의 16개 인터페이스 — 패키지 간 모든 경계에서 사용되는 타입-only seam. 새 구현체는 인터페이스를 만족하기만 하면 기본 구현을 그대로 교체할 수 있다 (DI 컨테이너 없음 — 생성자 주입).

> 모든 인터페이스는 `import type { Contracts } from '@agent-platform/core'` 또는 개별 모듈 (`@agent-platform/core/contracts/<name>`) 으로 가져온다. 네임스페이스 export 도 가능 (`Contracts.ChannelAdapter`).

| #   | 인터페이스                                       | 기본 구현                                       | 패키지                   |
| --- | ------------------------------------------------ | ----------------------------------------------- | ------------------------ |
| 1   | [`ChannelAdapter`](#1-channeladapter)            | WebChat / Telegram / Slack / Discord / WhatsApp | `packages/channels/*`    |
| 2   | [`SessionManager`](#2-sessionmanager)            | `ControlPlaneSessionManager`                    | `packages/control-plane` |
| 3   | [`Router`](#3-router)                            | `RuleRouter`                                    | `packages/control-plane` |
| 4   | [`EgoLayer`](#4-egolayer)                        | `EgoLayer`                                      | `packages/ego`           |
| 5   | [`EgoLlmAdapter`](#5-egollmadapter)              | `AnthropicEgoLlmAdapter`                        | `packages/ego`           |
| 6   | [`MemorySystem`](#6-memorysystem)                | `PalaceMemorySystem`                            | `packages/memory`        |
| 7   | [`PromptBuilder`](#7-promptbuilder)              | `PromptBuilder`                                 | `packages/agent-worker`  |
| 8   | [`ModelAdapter`](#8-modeladapter)                | `AnthropicAdapter` / `OpenAIAdapter`            | `packages/agent-worker`  |
| 9   | [`CapabilityGuard`](#9-capabilityguard)          | `PolicyCapabilityGuard`                         | `packages/agent-worker`  |
| 10  | [`ToolSandbox`](#10-toolsandbox)                 | `InProcessSandbox` / `DockerSandbox`            | `packages/agent-worker`  |
| 11  | [`SkillRegistry`](#11-skillregistry)             | `LocalSkillRegistry`                            | `packages/skills`        |
| 12  | [`GoalStore`](#12-goalstore)                     | `FileGoalStore`                                 | `packages/ego`           |
| 13  | [`PersonaManager`](#13-personamanager)           | `FilePersonaManager`                            | `packages/ego`           |
| 14  | [`AuditLog`](#14-auditlog)                       | `SqliteAuditLog`                                | `packages/ego`           |
| 15  | [`Reasoner`](#15-reasoner) (+`ComplexityRouter`) | `HybridReasoner`                                | `packages/agent-worker`  |
| 16  | [`TraceLogger`](#16-tracelogger)                 | `SqliteTraceLog` / `NoopTraceLogger`            | `packages/observability` |

---

## 1. ChannelAdapter

외부 메신저 ↔ `StandardMessage` 양방향 어댑터. 각 어댑터는 자체 구현으로 핸드셰이크 / 인증 / 헬스체크를 책임지고, 들어오는 메시지를 `onMessage` 콜백으로 단일 채널에 흘려보낸다.

```ts
interface ChannelAdapter {
  initialize(config: ChannelConfig): Promise<void>;
  shutdown(): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
  onMessage(handler: (msg: StandardMessage) => void): void;
  sendMessage(conversationId: string, content: OutboundContent): Promise<SendResult>;
  sendTypingIndicator(conversationId: string, isTyping: boolean): Promise<void>;
  isAllowed(senderId: string, conversationType: string): Promise<boolean>;
}
```

**핵심 규칙**

- `ChannelConfig` 는 자유 형식이지만 `type: string` 와 `credentials: Record<string, unknown>` 두 필드는 필수.
- `isAllowed(...)` 는 `ownerIds` / 그룹 멤버십 검사 등 어댑터별 정책 훅. 구현체에서 `false` 반환 시 메시지가 버스에 들어오지 않는다.
- `SendResult.status` 는 `'sent' | 'queued' | 'failed'` 셋만. queued 는 버퍼 가득 + 백오프 같은 임시 지연.

**기본 구현**

- `WebChatChannelAdapter` — 브라우저 ↔ 게이트웨이 WS (`/webchat`)
- `TelegramChannelAdapter` — Bot API 롱폴링
- `SlackChannelAdapter` — Events API webhook OR Socket Mode (transport union)
- `DiscordChannelAdapter` — Gateway WS v10 + Resume(op6) + sharding
- `WhatsAppChannelAdapter` — `WhatsAppClient` 추상 위에 Cloud API / baileys 구현 두 가지

---

## 2. SessionManager

세션 수명주기 + 이벤트 append-only 로그. ADR-010 의 핵심 요구는 `appendEvent` 가 INSERT 전용 (UPDATE/UPSERT 금지) 이라는 것.

```ts
interface SessionManager {
  resolveSession(msg: StandardMessage): Promise<Session>;
  getSession(sessionId: string): Promise<Session | null>;
  createSession(params: CreateSessionParams): Promise<Session>;
  updateSession(sessionId: string, patch: SessionPatch): Promise<Session>;

  appendEvent(sessionId: string, event: SessionEventInput): Promise<number>;
  loadHistory(sessionId: string, opts?: LoadHistoryOptions): Promise<SessionEvent[]>;

  compactSession(sessionId: string): Promise<CompactionResult>;
  hibernateSession(sessionId: string): Promise<void>;
  resumeSession(sessionId: string): Promise<Session>;
  sendToSession(fromId: string, toId: string, msg: string): Promise<void>;
}
```

**중요 동작**

- `resolveSession` — `(agentId, channelType, conversationId)` 튜플로 기존 세션을 매칭. `hibernated` 면 자동 `resumeSession`. inactivity 타임아웃 초과해도 같은 튜플이면 재사용 (`active` 로 전이).
- `loadHistory` 옵션:
  - `honorCompaction: true` (기본) — 가장 최근 compaction 이벤트 이후만 반환.
  - `includeKinds` — 기본은 `DEFAULT_PROMPT_EVENT_KINDS` (`'reasoning_step'` 제외).
  - `limit` — 기본 100, 최대 500.
- `appendEvent` 실패 시 throw — 호출자는 retry 없이 턴 실패로 전파.

**기본 구현**: `ControlPlaneSessionManager` (SQLite, `<stateDir>/state/sessions.db`)

---

## 3. Router

`StandardMessage` → `RouteDecision { agentId, sessionId?, priority }`. 규칙 추가/제거 API 는 핫리로드용 (재기동 없이 룰 갱신).

```ts
interface Router {
  route(msg: StandardMessage): Promise<RouteDecision>;
  addRule(rule: RoutingRule): void;
  removeRule(ruleId: string): void;
}
```

**기본 구현**: `RuleRouter` (선언적 매칭 — owner 여부, channel type, keyword 등)

---

## 4. EgoLayer

ADR-005/006 의 EGO 파이프라인. 단일 엔트리포인트 `process(msg, ctx) → EgoDecision`. `EgoDecision.kind` 는 `'passthrough' | 'enrich' | 'redirect' | 'direct_response'` 4값 (snake_case 고정).

```ts
interface EgoLayer {
  process(msg: StandardMessage, ctx: EgoContext): Promise<EgoDecision>;
}
```

**`EgoContext` 핵심 필드**: `sessionId`, `agentId`, `state`(`off|passive|active`), `recentTurns`, `traceId` 등. 자세한 스키마는 `core/src/schema/ego-context.ts`.

**state 별 동작**

- `'off'` — `process` 자체가 호출되지 않음 (게이트웨이가 우회).
- `'passive'` — 깊은 경로까지 다 돌리되 `kind` 를 강제로 `'passthrough'` 로 materialize. 관측 전용.
- `'active'` — 결정 그대로 적용.

**기본 구현**: `EgoLayer` (S1 Intake → S2 Normalize → fast-exit OR deep path with `EgoLlmAdapter` → audit). 자세한 흐름은 [architecture.md §4](../architecture.md#4-ego-파이프라인-상세).

---

## 5. EgoLlmAdapter

EGO 깊은 경로의 LLM 호출. **항상** JSON 출력 (`responseFormat: { type: 'json_object' }`). `EgoThinkingResult` 는 perception + cognition + judgment 를 하나로 융합한 구조 (의도된 단일 호출 — 비용 사유로 분리하지 않음).

```ts
interface EgoLlmAdapter {
  initialize(config: EgoLlmConfig): Promise<void>;
  think(request: EgoThinkingRequest): Promise<EgoThinkingResult>;
  healthCheck(): Promise<boolean>;
  getModelInfo(): { provider: string; model: string; isFallback: boolean };
}

interface EgoThinkingRequest {
  systemPrompt: string;
  context: {
    signal: unknown;
    recentConversation: MessageSummary[];
    relevantMemories: string[];
    activeGoals: unknown[];
    userProfile?: unknown;
  };
  responseFormat: { type: 'json_object' };
}
```

**기본 구현**: `AnthropicEgoLlmAdapter` (Claude Haiku-class, temp 0.1, ~1024 max tokens). 폴백 시 OpenAI 로 전환되며 `getModelInfo().isFallback` 이 `true`.

---

## 6. MemorySystem

하이브리드 검색 + ingest + 분류 + compaction. 모든 메서드가 선택적 `TraceCallContext` 를 받는다 — 비활성 시 silent.

```ts
interface MemorySystem {
  search(
    query: string,
    ctx: SearchContext,
    trace?: TraceCallContext,
  ): Promise<MemorySearchResult[]>;
  ingest(turn: ConversationTurn, trace?: TraceCallContext): Promise<IngestResult>;
  classify(content: string): Promise<ClassificationResult>;
  compact(wing: string, olderThan: Date): Promise<CompactionResult>;
}
```

**검색 가중치** (기본 구현 `PalaceMemorySystem`): `bm25 * 0.45 + vector * 0.45 + structureBoost * 0.1`. `SearchContext.preferredWings` 로 boost 대상 wing 지정 가능.

**Wing 4종**: `personal` / `work` / `knowledge` / `interactions`. `classify()` 가 자동 라우팅, 명시적으로 wing 지정도 가능.

---

## 7. PromptBuilder

세션 + 메모리 + 도구 + 사용자 메시지 → `BuiltPrompt`. EGO enrichment 와 persona snapshot 주입은 여기서 일어난다.

```ts
interface PromptContext {
  session: Session;
  agent: AgentConfig;
  memory: MemorySearchResult[];
  availableTools: ToolDefinition[];
  userMessage: StandardMessage;
}

interface PromptBuilder {
  build(ctx: PromptContext): Promise<BuiltPrompt>;
}
```

**`AgentConfig.personaSnapshot`** — `PersonaManager.snapshot()` 결과를 그대로 시스템 프롬프트에 끼워넣는 텍스트 블록.

---

## 8. ModelAdapter

LLM 스트리밍 추상. 어댑터별로 native JSON 모드 / tool calling / 토큰 회계 모두 자기 책임. AsyncIterable 기반이라 호출자는 `for await` 로 chunk 소비.

```ts
interface CompletionRequest {
  model: string;
  systemPrompt: string;
  messages: { role: string; content: string }[];
  tools?: { name: string; description: string; inputSchema: unknown }[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' | 'text' };
}

interface ModelAdapter {
  stream(request: CompletionRequest): AsyncIterable<StreamChunk>;
  getModelInfo(): ModelInfo;
  healthCheck(): Promise<ProviderHealth>;
}
```

**JSON 모드 처리**

- OpenAI: native `response_format: { type: 'json_object' }`.
- Anthropic: `{` prefill 트릭 (어시스턴트 메시지를 `{` 로 시작시켜 강제). SDK 0.88 기준.

**기본 구현**: `AnthropicAdapter` (`claude-sonnet-4-20250514` 기본), `OpenAIAdapter`.

---

## 9. CapabilityGuard

도구 호출 직전 ACL 체크. ADR-004 의 least-privilege 핵심 — 모든 sandbox.execute 호출이 이 가드를 통과한다.

```ts
interface CapabilityGuard {
  check(sessionId: string, toolName: string, args: unknown): Promise<CapabilityDecision>;
}
```

**`CapabilityDecision`** — `{ allow: true } | { allow: false, reason: string }`.

**기본 구현**: `PolicyCapabilityGuard` — `__default__` 단일 정책 객체. 멀티테넌트가 필요해지면 per-session 분리가 TODO.md 에 결정 항목으로 등재되어 있다.

---

## 10. ToolSandbox

acquire → execute → release 3단 수명주기. 동일 `SandboxInstance` 가 같은 세션의 여러 호출에 재사용된다.

```ts
interface ToolSandbox {
  acquire(policy: SessionPolicy, trace?: TraceCallContext): Promise<SandboxInstance>;
  execute(
    sandbox: SandboxInstance,
    tool: string,
    args: unknown,
    timeout: number,
    trace?: TraceCallContext,
  ): Promise<ToolResult>;
  release(sandbox: SandboxInstance, trace?: TraceCallContext): Promise<void>;
}
```

**기본 구현**

- `InProcessSandbox` — 호스트 프로세스 내부 실행. **빠르지만 격리 없음**. 빌트인 도구(fsRead/fsWrite/webFetch)에만 안전.
- `DockerSandbox` — `DockerTool` 프로토콜 (컨테이너에 stdin JSON, stdout/stderr 수집). `bash.run` 은 항상 컨테이너 강제. gVisor (`runsc`) 옵션 존재하나 실측 미완료 (TODO).

---

## 11. SkillRegistry

서명된 스킬 번들 (`packages/skills/builtin/<name>/`) 의 검색·설치·검증·목록.

```ts
interface InstallOptions {
  force?: boolean;
  skipVerification?: boolean;
}

interface SkillRegistry {
  search(query: string): Promise<SkillMetadata[]>;
  install(skillId: string, options?: InstallOptions): Promise<InstallResult>;
  listInstalled(): Promise<InstalledSkill[]>;
  verify(skillId: string): Promise<VerificationResult>;
}
```

**검증**: SHA-256 디렉토리 해시 (`hashSkillDirectory`) 가 manifest 의 `digest` 와 일치해야 한다. 일치 실패 시 `verify` 가 `{ ok: false, reason }` 반환.

**기본 구현**: `LocalSkillRegistry` (디렉토리 스캔 + SHA-256 검증). `mountInstalledSkills` 가 이걸 받아서 `LiveToolRegistry` 에 mount + 도구명 중복 감지.

---

## 12. GoalStore

ADR-007 의 `Goal` 영속화. 인터페이스는 의도적으로 작다 (CRUD + archive).

```ts
interface GoalStore {
  list(filter?: { status?: GoalStatus }): Promise<Goal[]>;
  get(id: string): Promise<Goal | null>;
  create(g: Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>): Promise<Goal>;
  update(id: string, patch: Partial<Goal>): Promise<Goal>;
  archive(id: string): Promise<void>;
}
```

**`Goal.status`**: `'active' | 'achieved' | 'abandoned' | 'paused'`.

**기본 구현**: `FileGoalStore` — `~/.agent/ego/goals.json`. 동시쓰기 보호는 atomic-write (temp + rename).

---

## 13. PersonaManager

페르소나 = `seed` (불변) + `learned` (진화) + `snapshot` (LLM 호출에 주입되는 텍스트). `evolve` 는 `ego-persona.md` §4 의 진화 규칙을 적용.

```ts
interface PersonaManager {
  load(): Promise<Persona>;
  snapshot(signal: NormalizedSignalLike): Promise<PersonaSnapshot>;
  evolve(feedback: PersonaFeedback): Promise<EvolutionResult>;
  export(): Promise<PersonaExport>;
  import(data: PersonaExport): Promise<void>;
}

interface EvolutionResult {
  changed: boolean;
  fieldPath?: string;
  delta?: number;
  reason?: string;
}
```

**`export` / `import`** — 다른 인스턴스로 페르소나 이전 (format `'ego-persona-v1'` + checksum). `includeMemory: true` 면 메모리 wing 도 동봉.

**기본 구현**: `FilePersonaManager` — `~/.agent/ego/persona.json`.

---

## 14. AuditLog

EGO 결정 + 운영 사건 감사 로그. 20+ 태그 (`ego_decision`, `ego_timeout`, `llm_schema_mismatch`, `daily_cost_cap_hit`, `circuit_breaker_open` 등).

```ts
interface AuditLogQuery {
  tag?: AuditTag;
  sessionId?: string;
  traceId?: string;
  sinceMs?: number;
  limit?: number;
}

interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
  query(q: AuditLogQuery): Promise<AuditEntry[]>;
  close(): Promise<void>;
}
```

**기본 구현**: `SqliteAuditLog` (`~/.agent/ego/audit.db`). `record` 실패 시 silent (감사 로깅 자체가 파이프라인을 깨면 안 됨).

---

## 15. Reasoner

ADR-009 의 reasoning 추상. `mode` 는 `'react' | 'plan_execute'`. `run()` 은 AsyncIterable 로 단계 / delta / 사용량 / 최종 응답을 흘려보낸다.

```ts
type ReasoningEvent =
  | { kind: 'step'; step: ReasoningStep }
  | { kind: 'delta'; text: string }
  | {
      kind: 'step_progress';
      stepId: string;
      goal: string;
      status: 'running' | 'success' | 'failed';
    }
  | { kind: 'usage'; inputTokens: number; outputTokens: number; cost?: number }
  | { kind: 'final'; text: string; state: ReasoningState };

interface Reasoner {
  mode: ReasoningMode;
  run(ctx: ReasoningContext): AsyncIterable<ReasoningEvent>;
}
```

**`ReasoningContext` 핵심 필드**

- `egoPerception?` / `egoCognition?` / `goalUpdates?` — EGO 의 깊은 경로 결과를 reasoner 로 패스스루. AgentRunner 가 `channel.metadata._egoPerception` 등에서 lift.
- `egoCognition.egoRelevance > 0.8` + `goalUpdates.length > 0` 이면 `PlanExecuteExecutor` 가 replan trigger #3 발동.
- `traceLogger?` — R1/R2/R3 블록 trace 주입. 없으면 silent.
- `abortSignal?` — 클라이언트 취소 전파.

**`ComplexityRouter`** (Reasoner 와 짝):

```ts
interface ComplexityRouter {
  select(input: ComplexityRouterInput): ReasoningMode;
}

interface ComplexityRouterInput {
  egoPerception?: Perception;
  userMessage: StandardMessage;
  availableTools: ToolDescriptor[];
  forceMode?: ReasoningMode;
}
```

`egoPerception.estimatedComplexity` 가 있으면 그걸로 라우팅 (`'low'` → react, `'medium'|'high'` → plan_execute). 없으면 텍스트 휴리스틱 (sentence count + imperative verbs + tool 후보 수). `forceMode` 또는 `requestType === 'workflow_execution'` 은 plan_execute 강제.

**기본 구현**: `HybridReasoner` (ReAct 와 Plan-Execute 를 ComplexityRouter 로 분기).

---

## 16. TraceLogger

블록 단위 구조화 trace. OTel `withSpan` 과 병행 — OTel 은 라이브 관측, TraceLogger 는 CLI 조회용 영속.

```ts
type TraceBlock =
  | 'G3' // gateway-cli chat.send RPC
  | 'C1' // control-plane RuleRouter
  | 'P1' // platform handler (orchestration)
  | 'E1' // EgoLayer.processDetailed
  | 'W1' // AgentRunner.processTurn
  | 'R1' // HybridReasoner mode select
  | 'R2' // ReactExecutor
  | 'R3' // PlanExecuteExecutor
  | 'M1' // ModelAdapter
  | 'X1' // Memory
  | 'S1'; // Sandbox

interface TraceEvent {
  traceId: string;
  sessionId?: string;
  agentId?: string;
  block: TraceBlock;
  event: TraceEventName | (string & {});
  timestamp: number;
  durationMs?: number;
  summary?: string;
  payload?: Record<string, unknown>;
  error?: string;
}

interface TraceLogger {
  event(entry: TraceEvent): void;
  span<T>(opts: TraceSpanOptions, fn: () => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}
```

**`TraceEventNames`** — canonical 이벤트 이름 상수 모음. 다운스트림 파서의 키 역할이라 임의 변경 금지. 주요 항목: `enter` / `exit` / `error` / `decision` / `fast_exit` / `tool_call` / `mode_selected` / `plan_generated` / `replan` / `downgraded_to_react` / `first_token` / `memory_searched` / `sandbox_executed` 등.

**`TraceCallContext`** — TraceLogger 를 직접 들고 다니지 않는 서브시스템 (memory / sandbox / model-adapter)이 자기 내부 이벤트를 surface 하는 용도. 항상 optional — 누락되면 silent.

**불변량**: `event()` / `span()` 의 비-wrapped 실패는 절대 throw 금지. trace 로깅이 파이프라인을 깨면 안 된다.

**기본 구현**: `SqliteTraceLog` (`<stateDir>/trace/traces.db`). `AGENT_TRACE=0` 시 `NoopTraceLogger` 로 대체. `AGENT_TRACE_RETENTION_DAYS` (기본 14) 로 prune-on-boot.

---

## 확장 가이드

### 새 채널 어댑터 추가

1. `packages/channels/<name>/src/adapter.ts` 에 `ChannelAdapter` 구현.
2. `index.ts` 에서 export — config factory 로 `ChannelConfig` 검증.
3. 메시지를 `StandardMessage` 로 정규화할 때 `channel.type`, `channel.conversationId`, `sender.isOwner`, `metadata` 를 정확히 채울 것.
4. 통합 테스트는 mock client 패턴 (`telegram-mock-client.ts` 등 참고).

### 새 ModelAdapter 추가

1. `CompletionRequest` 의 `messages` 형태(role/content 단순 페어)를 provider native 형식으로 변환.
2. `responseFormat: 'json_object'` 가 들어오면 provider 별 JSON 강제 (native or prefill 트릭).
3. `ModelInfo` 에 비용 단가 (`$/M tokens`) 채워야 토큰 회계가 동작.
4. tool calling 은 `tools` 가 들어왔을 때만 활성, 응답에서 tool_use chunk 를 `StreamChunk` 의 tool 형태로 정규화.

### 새 ToolSandbox 추가 (예: gVisor / kata)

1. `acquire(policy)` — 별도 컨테이너/VM 기동, `SandboxInstance` 핸들 반환.
2. `execute` 는 `policy.networkPolicy`, `policy.fsPolicy` 등을 **플랫폼이 아니라 sandbox 가** 강제해야 함 (CapabilityGuard 는 ACL 만 본다).
3. `release` 는 idempotent — 중복 호출 안전.
4. `bash.run` 도구는 항상 컨테이너 강제이므로 `InProcessSandbox` 로 라우팅하지 말 것.

---

## 관련 문서

- [architecture.md](../architecture.md) — 전체 데이터 흐름 + 패키지 지도
- [configuration.md](../configuration.md) — 모든 설정 파일 필드
- [packages/core/src/contracts/](../../packages/core/src/contracts/) — 원본 인터페이스 파일 (이 문서의 진실 소스)
- 원본 설계: [harness-engineering.md](../../../claude/harness-engineering.md) (ADR-001~010)
