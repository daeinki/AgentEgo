# visualize_architecture.md — TUI/Webapp 메시지 흐름 블록 다이어그램

> **문서 버전**: v0.7.0
> **작성일**: 2026-04-25
> **상위 문서**: harness-engineering.md v0.7.0 / ego-design.md v0.3.0 / agent-orchestration.md v0.1.0
> **목적**: `agent-tui` 및 브라우저 **webapp 대시보드** 에 입력된 사용자 발화가 최종 응답으로 돌아오기까지 거치는 모든 블록을 한눈에 보이게 한다. 각 블록의 (입력 → 처리 → 출력 → 다음 블록) 을 규약과 함께 기록해, 코드가 바뀌어도 본 문서의 §12 "재생성 가이드" 만으로 새 다이어그램을 재현할 수 있도록 한다.
> **스코프**: 설계 리포(`D:\ai\claude`) + 구현 리포(`D:\ai\agent-platform`) v0.7.0 기준. TUI/Webapp → Gateway RPC → Control Plane → EGO → Agent Runner → Reasoner → (도구/모델/스킬) → 스트림 복귀 경로를 다룬다. TUI 와 Webapp 은 동일 `/rpc` 계약 위에서 돌아가며 인증만 다르다 — §14 "Webapp 서피스 차이" 에서 델타만 서술한다. webchat/HTTP/채널 어댑터는 동일 `handler()` 를 공유하므로 §11 에 짧게만 언급한다. 파이프라인에 가로지르는 **TraceLogger** 관찰성 레이어는 §13 에서 별도 서술한다.
>
> **v0.7 변경 요약** (2026-04-25, Channels/Cron 실데이터 + Reasoning trigger #3 + device CLI):
> - **[C2'] ChannelRegistry 실구현** — `PlatformChannelRegistry` ([packages/control-plane/src/gateway/platform-channel-registry.ts](D:\ai\agent-platform\packages\control-plane\src\gateway\platform-channel-registry.ts)) 신규. `platform.ts` 가 WebChat 부팅 시 `register('webchat', 'webchat', adapter)` 호출, `onMessage` 수신마다 `recordEvent`, catch 에서 `recordError`, shutdown 에서 `deregister`. `ChannelAdapter.healthCheck()` 를 온디맨드 `refreshHealth(id)` 경로로 호출해 status 파생. `channels.list` / `channels.status` RPC 가 이제 실 데이터 반환 (이전에는 빈 배열).
> - **[C2''] CronRegistry + Scheduler 실구현 (option B)** — `packages/scheduler/` 신규 패키지. `CronTask` discriminated union (chat/bash/workflow) + `TaskRunner` 인터페이스. `SchedulerService` 가 `node-cron` 으로 스케줄 관리 + 단일동시성 보장(overlap 시 skip, runNow 는 거절). 3 runner — `ChatTaskRunner`(platform handler 직접 호출, EGO 자동 경유, `sessionStrategy: 'pinned'|'fresh'`), `BashTaskRunner`(ToolSandbox + ownerPolicy 경유, 직접 spawn 금지), `WorkflowTaskRunner`(`executeWorkflow` 래핑, sandbox 1회 acquire per workflow). tasks.json JSON5 스타일 (주석·trailing comma 허용). v1 스코프: RPC mutation 없음(재시작으로 반영), 실행 이력 인메모리, 실패 정책 log-and-continue. `cron.list` / `cron.runNow` RPC 가 이제 실 데이터 반환.
> - **[R3] Replan 트리거 #3 구현** — `agent-orchestration.md` §4.4 의 세 번째 replan 트리거 (egoRelevance>0.8 + goalUpdates 존재) 구현. EGO `Cognition` + `goalUpdates[]` 를 metadata `_egoCognition` / `_egoGoalUpdates` 로 전달 → `AgentRunner` 가 추출해 `ReasoningContext.egoCognition` / `goalUpdates` 로 포워드 → `PlanExecuteExecutor` 가 초기 plan 직후 조건 충족 시 재계획 1회 발화 (`reason: 'goal_updates_high_relevance'`). `replanLimit` 공유로 트리거 #1 과 합쳐도 상한 초과 없음. 계획은 goal-update 맥락을 surface 한 전용 프롬프트로 다시 생성되며, 성공 step id 는 트리거 #1 과 동일 규칙으로 보존.
> - **[CLI] `agent device {list,revoke}`** — `packages/cli/src/commands/device.ts` 신규. `DeviceAuthStore` 직접 열어(`devices.json` 만 읽음, gateway 실행 불필요) 등록된 디바이스를 deviceId·name·enrolledAt·lastSeenAt 테이블(또는 `--json`)로 출력하고, `revoke <id>` 로 즉시 무효화 — 기존 세션 토큰은 `verifySessionToken` 에서 `device revoked` 사유로 거절.
> - **§14.6 Webapp Control 폴링 주의** 갱신: 더 이상 "registered adapter 없음" 상태가 아님 — `channels.list` 는 실제 기동된 어댑터(현재 webchat 1개)를, `cron.list` 는 `<stateDir>/scheduler/tasks.json` 에 정의된 태스크를 반환.
>
> **v0.6 변경 요약** (ADR-010 반영):
> - **신규 §14 "Webapp 서피스"**: `packages/webapp` (Vite + Lit 3) 도입 반영. TUI 의 [T1]~[T3] 에 대응하는 [B1]~[B3] 브라우저 블록, [D1] 디바이스 인증 컨트롤러, [G4] `/device/*` 라우트, [G5] WS `Sec-WebSocket-Protocol: bearer.<token>` 인증 분기.
> - **신규 §15 "Phase-Format 공유"**: `formatPhase`/`PhaseIndicator`/`PHASE_LABELS`/`PHASE_ICONS` 가 `packages/core/src/schema/phase-format.ts` 로 승격 — TUI `<PhaseLine>` 과 Webapp `<phase-line>` 양쪽이 import. 서브패스 export `@agent-platform/core/phase-format`.
> - **§3 Gateway 라우트 테이블 확장**: `/device/enroll`(마스터 Bearer 필요) · `/device/challenge` · `/device/assert` · `/ui/*` 정적 서빙. ApiGateway `TokenAuth` 에 secondary verifier (DeviceAuthStore) 체인 추가.
> - **§3 신규 RPC 메서드**: `overview.status` / `channels.list` · `channels.status` / `instances.list` / `cron.list` · `cron.runNow` / `sessions.events` — Webapp Control 섹션 뷰가 소비. `RpcDeps.channels?` / `cron?` 은 옵셔널 레지스트리 주입 지점.
> - **§0 전체 다이어그램**: TUI 위에 Webapp 블록이 병렬 배치. 두 서피스 모두 동일 `chat.phase` 스트림을 구독.
>
> **v0.5 변경 요약**:
> - [E1] EgoLayer 에러 진단 확장: `SchemaValidationError` 가 실제 분류 `tag`(llm_invalid_json / llm_schema_mismatch / llm_out_of_range / llm_inconsistent_action / llm_invalid_target) + 파싱된 invalid `candidate` 를 전달. E1 `error` trace payload 가 `tag` · `validationErrors[{path,message}]` (5건 cap) · `candidatePreview` (800자 cap) 를 포함 — 이전에는 `error` 문자열만 남았음
> - [E1] LLM 프롬프트 그라운딩: `buildUserPrompt` 가 `EgoThinkingResult` JSON Schema 를 전문 주입 + action-contingent 필수 필드 규칙(enrich→enrichment, redirect→redirect.target*, direct_response→directResponse.text) 명시 → `llm_schema_mismatch` 발생 빈도 감소
> - [core/time.ts] `TimeoutError extends Error` 추가(`label`, `timeoutMs`, `name='TimeoutError'`). `withTimeout` 이 이 클래스를 throw. [E1] layer 의 timeout 판정이 `TimeoutError` 를 인식해 `ego_timeout` 태그로 정확히 기록(이전에는 never-thrown `EgoTimeoutError` 만 체크해 모든 pipeline 타임아웃이 `ego_runtime_error` 로 오분류)
> - [K1] Skill loader: 레거시 `call(args, ctx)` 메서드를 `execute(args, ctx)` 로 자동 정규화 — agent 가 과거 convention 으로 작성한 스킬이 `loaded.execute is not a function` 으로 silent 실패하던 회귀 수정. 다른 tool 필드(description/permissions/riskLevel/inputSchema/runsInContainer/dockerCommand)는 그대로 보존
> - [K2] 내장 스킬 목록: `trace-lookup` 추가. 에이전트가 자신의 파이프라인 trace 를 조회하는 `trace.list` / `trace.show` / `trace.last` 3 툴 노출. self-contained(`node:sqlite` 만 사용) + read-only(`<stateDir>/trace/traces.db` open with `{ readOnly: true }`)
>
> **v0.4 변경 요약**:
> - ADR-010 TUI Phase Event Stream 엔드투엔드 반영: `chat.phase` JSON-RPC notification 추가 ([G3] 발행, [T3] 수신), 13값 Phase 어휘(`received → ego_judging → reasoning_route → planning|tool_call|replan → streaming_response → finalizing → complete|aborted|error`)
> - [P1] Platform handler: EGO 진입 직전 `ego_judging` phase emit, runner 호출에 `ctx.emitPhase` 전달
> - [W1] AgentRunner: 4번째 인자 `onPhase` 콜백 추가 — `reasoning_route`(with reasoningMode), 첫 delta 에서 `streaming_response` 1회, ReasoningStep kind → phase 매핑(tool_call/planning/replan)
> - [T2] App.send(): `chat.phase` 알림 수신, InputBar **아래** `PhaseLine` 에 현재 phase 표시(ETA 없음)
> - [T2] ChatHistory: Ink `<Static>` 채택 — 완료된 turn 은 스크롤백에 1회 commit, 스트리밍 중 이전 출력 repaint 제거 (flicker 수정). streaming turn 은 StatusLine 바로 위 flex column 에 명시 배치 → 모든 응답은 "connected ws://…" 라인 **위쪽**에만 출력
> - [K2] 신규 블록: `seedBuiltinSkills` 부트스트랩 + `architecture-lookup` 내장 스킬. gateway 기동 시 `packages/skills/builtin/*` 를 `~/.agent/skills/*/` 로 idempotent 시드(버전 비교 기반 업그레이드, 사용자 수정 보존). `architecture.lookup` + `architecture.search` 두 툴 노출 — 본 문서 자체를 런타임 에이전트가 섹션 단위로 조회 가능
>
> **v0.3 변경 요약**:
> - ADR-010 반영: [C2] SessionStore `getRecentEvents` → `loadHistory`, `appendEvent`/`loadHistory` 공개 계약, `reasoning_step` event_type 공식 포함
> - [W1] AgentRunner: `session_resolved` · `session_events_appended` 관측, 턴당 `reasoning_step` best-effort append
> - [E1] EgoLayer: `fastPath.enabled` 게이트 + `EGO_FORCE_DEEP` env, `suggestTools` 힌트를 PromptBuilder 로 전파
> - [M1] ModelAdapter: OpenAI/Anthropic tool name sanitize (`fs.read` → `fs_read`) + assistant `toolCalls` 직렬화
> - EGO LLM adapter: gpt-5.x / o1-o4 `max_completion_tokens` · temperature 제외 분기
> - [S1] + 신규 [K1] LiveToolRegistry: 런타임 도구 재마운트, 신규 `fs.list` + `skill.create/list/remove/reload` 5 tool, PolicyCapabilityGuard 경계
> - Platform zero-config: `~/.agent/system-prompt.md` + `~/.agent/skills/` + `<stateDir>/workspace/` 기본 주입

---

## 0. 한눈에 보기 — 전체 블록 다이어그램

TUI 와 Webapp 은 동일 `/rpc` 엔드포인트에 수렴한다 — 상단 서피스만 다르고 [G1] 이후는 공유. 아래 다이어그램은 TUI 경로 기준으로 그리고, Webapp 쪽 [B1]~[B3]/[D1]/[G4]/[G5] 블록은 §14 에서 분기 설명한다.

```
 ┌────────────────────────────────┐          ┌────────────────────────────────┐
 │  사용자 터미널 (TUI)             │          │  브라우저 탭 (Webapp)             │
 └──────────────┬─────────────────┘          └──────────────┬─────────────────┘
                │ keypress                                  │ click / type
                ▼                                           ▼
         [T1] InputBar                              [B1] chat-input (Lit)
         [T2] App.send                              [B2] ChatController.send
         [T3] RpcClient  ──── ws://…/rpc ────────── [B3] BrowserRpcClient
                │ Bearer master token                │ Sec-WebSocket-Protocol
                │ (Authorization header)             │   = 'bearer.<sessionToken>'
                └─────────────┬──────────────────────┘
                              │ (두 전송 방식 모두 [G1] 에서 합류)
                              ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ [T1] TUI: InputBar (Ink React)                                               │
 │      in : key events                                                         │
 │      do : Enter 시 trim 후 onSubmit(text)                                    │
 │      out: string                                                             │
 └────────────────────────────────┬─────────────────────────────────────────────┘
                                  │ onSubmit(text)
                                  ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ [T2] TUI: App.send()  (packages/tui/src/App.tsx)                             │
 │      in : text                                                               │
 │      do : userId/agentId 발급, turns 배열에 user+placeholder assistant 삽입  │
 │           params = { text, conversationId, sessionId? }                      │
 │      out: RpcClient.call('chat.send', params, { onNotification })            │
 └────────────────────────────────┬─────────────────────────────────────────────┘
                                  │ call('chat.send', params, opts)
                                  ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ [T3] TUI: RpcClient  (packages/tui/src/lib/rpc-client.ts)                    │
 │      in : method, params, opts                                               │
 │      do : id 할당, pending map 등록, timeoutMs(기본 5분) 타이머 세팅         │
 │           ws.send(JSON.stringify({jsonrpc:'2.0', id, method, params}))       │
 │      out: WebSocket 프레임 ── ws://host:port/rpc                             │
 └────────────────────────────────┬─────────────────────────────────────────────┘
                                  │ JSON-RPC request frame  (TCP/WS)
                                  ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ [G1] ApiGateway  (control-plane/src/gateway/server.ts)                       │
 │      in : HTTP Upgrade + Bearer (TUI) 또는 Sec-WebSocket-Protocol            │
 │           "bearer.<token>" (Webapp)                                          │
 │      do : TokenAuth.verifyBearer — 마스터 토큰(timingSafeEqual) 실패 시       │
 │           secondary verifier(DeviceAuthStore.verifySessionToken) 로 fallback │
 │           → 레이트리밋 + path 라우팅. '/rpc' 로 upgrade → RpcServer          │
 │      out: 업그레이드된 WebSocket → RpcServer.handleUpgrade()                 │
 └────────────────────────────────┬─────────────────────────────────────────────┘
                                  │ upgraded WS
                                  ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ [G2] RpcServer  (gateway-cli/src/rpc/server.ts)                              │
 │      in : JSON-RPC request frame                                             │
 │      do : parseInbound → methods[req.method] 조회                            │
 │           per-request AbortController + RpcContext 생성                      │
 │           ctx.notify(method,params) = ws.send(notification-frame)            │
 │      out: await handler(params, ctx) 의 결과 → successFrame / errorFrame     │
 └────────────────────────────────┬─────────────────────────────────────────────┘
                                  │ params, ctx → methods['chat.send']
                                  ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ [G3] RpcMethods: 'chat.send'  (gateway-cli/src/rpc/methods.ts)               │
 │      in : { text, conversationId?, sessionId?, agentId?, channelId? }        │
 │      do : StandardMessage 구성 (channel.type='webchat', content.type='text') │
 │           route = await deps.router.route(msg)  → sessionId, agentId 확정    │
 │           ctx.notify('chat.accepted', {sessionId, traceId, …})               │
 │           handlerCtx.emit = (text)=> ctx.notify('chat.delta',{requestId,text})│
 │      out: usage = await deps.handler(msg, handlerCtx)                        │
 │           return { sessionId, agentId, traceId, usage }                      │
 └──────┬──────────────────────────────────────────┬────────────────────────────┘
        │ router.route(msg)                        │ handler(msg, handlerCtx)
        ▼                                          ▼
 ┌─────────────────────────────┐       ┌────────────────────────────────────────┐
 │ [C1] RuleRouter             │       │ [P1] Platform handler  (platform.ts)   │
 │   control-plane/session/    │       │  in : StandardMessage, HandlerContext  │
 │     router.ts               │       │  do : withSpan('platform.handleTurn')  │
 │   in : StandardMessage      │       │        1) EGO 판단                     │
 │   do : rules 우선순위 매칭, │       │        2) 결과에 따라 direct_response  │
 │        defaultAgentId       │       │           emit 또는 AgentRunner 위임   │
 │        ('default') 로 폴백  │       │        3) metrics.recordTurn 기록      │
 │        → SessionStore.      │       │  out: { inputTokens, outputTokens,     │
 │          resolveSession()   │       │          costUsd }                     │
 │   out: { agentId, sessionId}│       └───────┬───────────────────────┬────────┘
 └──────────┬──────────────────┘               │ ego.processDetailed() │ runner.processTurn()
            │                                  ▼                       │
            ▼                     ┌───────────────────────────┐         │
 ┌─────────────────────────────┐  │ [E1] EgoLayer             │         │
 │ [C2] SessionStore           │  │   packages/ego/src/layer.ts         │
 │   control-plane/session/    │  │  in : StandardMessage +             │
 │     store.ts (SQLite)       │  │       {sessionId, agentId}          │
 │   in : (agentId,channelType,│  │  do : intake→normalize→fastExit 검사│
 │        conversationId)      │  │       [Fast path ] shouldFastExit → │
 │   do : SELECT 또는 INSERT   │  │         {action:'passthrough'}      │
 │        세션 / ingest event  │  │       [Deep path]                   │
 │   out: Session row          │  │         gatherContext(memory,goals, │
 │                             │  │           recentHistory, persona)   │
 │        + getRecentEvents(   │  │         systemPrompt = base +       │
 │          sessionId, 50)     │  │           personaSnapshot           │
 │        → history 리스트     │  │         llm.think({systemPrompt,    │
 └─────────────────────────────┘  │           context, responseFormat:  │
                                  │           json_object})             │
                                  │         validateEgoThinking() 실패 시│
                                  │           SchemaValidationError →   │
                                  │           fallback passthrough      │
                                  │         state==='passive' → 판정만  │
                                  │           하되 action='passthrough' │
                                  │         cost cap 초과 → state       │
                                  │           자동 downgrade            │
                                  │         minConfidenceToAct 미달 →   │
                                  │           passthrough 로 override   │
                                  │         audit.record(…)             │
                                  │  out: ProcessRecord {               │
                                  │       decision:{action: 'passthrough│
                                  │         |enrich|redirect|           │
                                  │         direct_response'},          │
                                  │       thinking?, metadata?, costUsd }│
                                  └──────┬────────────────────────┬─────┘
                                         │ direct_response         │ enrich / passthrough
                                         ▼                         ▼
                              ┌──────────────────────┐  ┌────────────────────────────┐
                              │ [P1-a]               │  │ [P1-b] 메시지 재조립        │
                              │ ctx.emit(dr.text)    │  │   baseMsg = enriched        │
                              │ return {}            │  │     ? decision.enrichedMsg  │
                              │                      │  │     : originalMsg           │
                              │ (텍스트 한 번에 TUI  │  │   thinking.* → channel.meta │
                              │  스트리밍으로 복귀)  │  │     _egoPerception +         │
                              │                      │  │     _egoCognition +          │
                              │                      │  │     _egoGoalUpdates(?) 부착 │
                              └──────────────────────┘  └──────────────┬──────────────┘
                                                                       │ runner.processTurn(sessionId, effectiveMsg, ctx.emit)
                                                                       ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ [W1] AgentRunner  (agent-worker/src/runner/agent-runner.ts)                  │
 │   in : sessionId, StandardMessage, onChunk                                   │
 │   do : ① session_resolved 관측 (getSession 으로 isNew 판정)                  │
 │        ② extractText(msg) / extractEgoEnrichment(+suggestedTools) /          │
 │             extractEgoPerception / extractEgoCognition /                     │
 │             extractEgoGoalUpdates                                            │
 │        ③ sessionStore.loadHistory(sessionId, {limit:50})  — ADR-010          │
 │             (reasoning_step 기본 제외)  → history_loaded 관측                │
 │        ④ PromptBuilder.build({systemPrompt, sessionEvents, userMessage,      │
 │              egoEnrichment+suggestedTools}) → { systemPrompt, messages[] }   │
 │        ⑤ priorMessages = messages.slice(0,-1)                                │
 │        ⑥ availableTools = toolRegistry.descriptors() ?? deps.tools ?? []     │
 │             (LiveToolRegistry 스냅샷 — 다음 턴부터 skill.create 결과 노출)   │
 │        ⑦ Reasoner.run(ReasoningContext)                                      │
 │        ⑧ for await (ev of ctx):                                              │
 │              delta → responseText+=ev.text; onChunk(ev.text)                 │
 │              usage → {inputTokens, outputTokens, cost}                       │
 │              step  → appendEvent({eventType:'reasoning_step'}) (best-effort) │
 │              final → responseText = ev.text (비어있지 않으면 덮어쓰기)       │
 │        ⑨ sessionStore.appendEvent(user_message) + appendEvent(agent_response)│
 │             → session_events_appended 관측 (실패 시 session_append_failed)   │
 │        ⑩ memory.ingest({sessionId,userMessage,agentResponse}) (best-effort) │
 │   out: TurnResult { responseText, inputTokens, outputTokens, costUsd,        │
 │                     latencyMs, ingested }                                    │
 └──────┬────────────────────────────────────────┬──────────────────────────────┘
        │ reasoner.run(ctx)                      │ onChunk(text)
        ▼                                        ▼ (deltas)
 ┌──────────────────────────────────────┐   (handlerCtx.emit)
 │ [R1] HybridReasoner                  │   (ctx.notify('chat.delta',…))
 │   agent-worker/src/reasoning/        │      │
 │     hybrid-reasoner.ts               │      │  역방향 스트림
 │   in : ReasoningContext {sessionId,  │      │
 │          agentId, userMessage,       │      ▼
 │          systemPrompt, priorMessages,│   [G2].notify → WS 프레임 →
 │          availableTools,             │   [T3].handleMessage → pending.onNotification
 │          egoDecisionId?,             │   → [T2] setTurns 업데이트 → [T1] 렌더
 │          egoPerception?,egoCognition?,│
 │          goalUpdates?}               │
 │   do : ComplexityRouter.select({     │
 │         userMessage, availableTools, │
 │         egoPerception}) →            │
 │           'react' | 'plan_execute'   │
 │        도구 미배선 시 plan_execute   │
 │          unavailable → 항상 'react'  │
 │        → 선택된 executor.run(ctx)    │
 │   out: AsyncIterable<ReasoningEvent> │
 └──────┬──────────────────────┬────────┘
        │ mode='react'         │ mode='plan_execute'
        ▼                      ▼
 ┌──────────────────────┐   ┌───────────────────────────────────────────────┐
 │ [R2] ReactExecutor   │   │ [R3] PlanExecuteExecutor                      │
 │  react-executor.ts   │   │   plan-execute-executor.ts                    │
 │  in : ctx, budget    │   │  in : ctx (+ plannerModel)                    │
 │  do : 스트리밍 루프  │   │  do : (1) planner LLM 호출 → JSON plan 파싱   │
 │       - 모델 호출    │   │           (실패 시 ReAct 다운그레이드)       │
 │         prompt =     │   │       (2) computeLevels() 로 의존성 레벨 분리 │
 │         systemPrompt │   │       (3) 각 레벨 stepRetryLimit 재시도       │
 │         + prior+user │   │           - parallelExecution: Promise.all    │
 │       - tool_calls   │   │           - step.id 매칭 시 과거 성공 단계    │
 │         파싱         │   │             status/observation 자동 승계      │
 │       - CapabilityGuard.check  │       (4) 한도 초과 replanLimit 회      │
 │         → ToolSandbox.invoke │         재계획                            │
 │         → Observation  │       (5) 다 소진 시 ReAct 다운그레이드         │
 │         를 다음 턴    │           (augmented user message + fresh budget)│
 │         메시지에 첨부 │           (내부적으로 ReactExecutor 호출)        │
 │       - maxSteps/     │  out: AsyncIterable<ReasoningEvent>              │
 │         maxToolCalls 까지│                                               │
 │         반복         │                                                   │
 │  out: AsyncIterable   │                                                  │
 │       <ReasoningEvent>│                                                  │
 │       delta / usage / │                                                  │
 │       final           │                                                  │
 └──────┬───────────────┘                                                   │
        │ 공용 (R2 + R3 모두 아래 두 블록에 의존)                           │
        ▼                                                                   │
 ┌────────────────────────────┐    ┌───────────────────────────────────────┐│
 │ [M1] ModelAdapter          │    │ [S1] ToolSandbox (+ CapabilityGuard)  ││
 │   agent-worker/src/model/  │    │   agent-worker/src/security           ││
 │   cli/runtime/model-adapter│    │   platform 에서 InProcessSandbox +    ││
 │   in : {systemPrompt,      │    │     PolicyCapabilityGuard + Live-     ││
 │         messages(+toolCalls)│   │     ToolRegistry.asMap() 주입         ││
 │         tools?}            │    │   in : (sessionId, toolName, args)    ││
 │   do : Anthropic / OpenAI  │    │   do : policy 조회 (없으면 ownerPolicy│◀┘
 │        SDK 호출 + chunk    │    │        lazy-populate) → allow/deny    │
 │        스트림 yield        │    │        - filesystem.write / process   │
 │        - tool name sanitize│    │          은 owner-trust 필요          │
 │          (fs.read→fs_read) │    │        허가 시 tool.execute(args)     │
 │        - assistant         │    │          (LiveToolRegistry 조회 —     │
 │          toolCalls →       │    │           skill.create 후 자동 노출)  │
 │          provider tool_use │    │   out: ToolResult                     │
 │        - gpt-5.x/o1-4 는   │    └─────────────────┬─────────────────────┘
 │          max_completion_   │                      │ LiveToolRegistry.asMap()
 │          tokens + temp 제외│                      ▼
 │   out: streamed text +     │    ┌───────────────────────────────────────┐
 │        usage 이벤트         │    │ [K1] LiveToolRegistry +               │
 └─────────────────────────────┘    │      LocalSkillRegistry               │
                                   │   agent-worker/src/tools/live-        │
                                   │     registry.ts + skills/src/*        │
                                   │   in : skill.create(id, sourceCode,   │
                                   │          permissions) 등              │
                                   │   do : base + user + authoring + 기   │
                                   │        설치 skill tool 을 단일 Map 로 │
                                   │        관리. asMap() 이 live ref →    │
                                   │        sandbox/guard 수정 없이도      │
                                   │        런타임 등록 즉시 반영          │
                                   │        skill.create 시 staging →      │
                                   │          index.js + manifest (hash +  │
                                   │          HMAC 자가서명) → install →   │
                                   │          remount → registerAll        │
                                   │        entryPoint traversal 가드 +    │
                                   │          eval/child_process/require/  │
                                   │          dynamic-import 정적 거부     │
                                   │   out: AgentRunner 다음 턴부터 새     │
                                   │        tool 을 availableTools 로 노출 │
                                   └───────────────────────────────────────┘

 (이후 스트림 · 최종 응답 경로)

  [R2/R3] → [W1] (ev.delta/usage/final)
        → [W1].onChunk(text) 호출
           → [P1] handlerCtx.emit(text)
              → [G3] ctx.notify('chat.delta', {requestId, text})
                 → [G2] ws.send(notification frame)
                    → [T3] handleMessage → pending.onNotification(method, params)
                       → [T2] setTurns(prev → assistant.text += delta)
                          → [T1→ChatHistory] 실시간 렌더
  [R2/R3].usage → [W1] inputTokens/outputTokens/costUsd 집계
  [W1] 반환 TurnResult → [P1] metrics.recordTurn → 최종 반환 { usage }
  [G3] 최종 response frame = { id, result:{ sessionId, agentId, usage, traceId, messageId } }
  [T3] handleMessage → pending.resolve → [T2].send() .then(result =>
    setTurns: streaming=false, usage=result.usage)
  [T1→ChatHistory] 최종 상태 (token usage 뱃지 표시) 렌더 종료
```

---

## 1. 블록 식별자 네이밍

본 문서 전반에서 동일한 식별자를 재사용한다:

| Prefix | 레이어 | 위치 |
|--------|--------|------|
| `T*` | TUI (Terminal UI / Ink) | `agent-platform/packages/tui/` |
| `G*` | Gateway (HTTP + JSON-RPC over WS) | `packages/control-plane/src/gateway/` + `packages/gateway-cli/src/rpc/` |
| `C*` | Control plane — 라우팅 / 세션 | `packages/control-plane/src/session/` |
| `P*` | Platform wiring + handler | `packages/cli/src/runtime/platform.ts` |
| `E*` | EGO 레이어 | `packages/ego/src/` |
| `W*` | Worker (AgentRunner + Prompt) | `packages/agent-worker/src/runner/`, `…/prompt/` |
| `R*` | Reasoner (ADR-009) | `packages/agent-worker/src/reasoning/` |
| `M*` | ModelAdapter | `packages/agent-worker/src/model/`, `packages/cli/src/runtime/model-adapter.ts` |
| `S*` | Sandbox / CapabilityGuard | `packages/agent-worker/src/security`, `…/tools` |
| `K*` | LiveToolRegistry + LocalSkillRegistry (U10) | `packages/agent-worker/src/tools/live-registry.ts`, `packages/skills/src/` |
| `X*` | 외부/곁가지 (memory, audit, metrics) | `packages/memory/`, `…/ego/audit-log.ts`, `…/observability/` |

---

## 2. [T1~T3] TUI 레이어 — 사용자 입력 → RPC 송신

### [T1] InputBar
- **파일**: [packages/tui/src/components/InputBar.tsx](D:\ai\agent-platform\packages\tui\src\components\InputBar.tsx)
- **입력**: 터미널 키 이벤트 (Ink `useInput`). 부모로부터 `busy`, `placeholder`, `onSubmit`.
- **처리**: `key.return` 이면 `text.trim()` 후 비어있지 않으면 `onSubmit(text)` 호출 + state 초기화.
- **출력**: `onSubmit(text: string)` 콜백.
- **다음 블록**: [T2] App.send()

### [T2] App (최상위 컨테이너)
- **파일**: [packages/tui/src/App.tsx](D:\ai\agent-platform\packages\tui\src\App.tsx)
- **입력**: `AppProps { host, port, authToken, conversationId, sessionId? }` (CLI 인자), `InputBar.onSubmit`.
- **처리**:
  1. `useRpc({ url, authToken })` 로 WS 연결 유지. `status` = `connecting` | `open` | `reconnecting` | `closed`.
  2. 초기 연결 시 `gateway.health` 와 (선택) `chat.history` 호출.
  3. `send(text)` 에서:
     - 새 `userId` / `agentId` (UI-로컬) 발급.
     - `turns` 배열에 user 메시지 + placeholder assistant(streaming: true) 추가.
     - `client.call('chat.send', { text, conversationId, sessionId? }, { timeoutMs: 5*60*1000, onNotification })`.
     - notification 수신:
       - `chat.accepted` → `activeSessionId` 세팅.
       - `chat.delta` → 해당 assistant turn 의 `text += params.text`.
       - **`chat.phase` (ADR-010)** → `phase` state 갱신(`PhaseIndicator { phase, elapsedMs, detail? }`); terminal phase 또는 `streaming_response` 수신 시 인디케이터 클리어. `PhaseLine` 이 InputBar **아래**에 한 줄 렌더 (ETA 없음).
     - `.then(result)` → streaming=false + usage 표시. `.finally()` 에서 phase=null.
     - **Flicker-free 렌더 (ADR-010)**: 완료된 turn 은 Ink `<Static>` (position:absolute) 을 통해 스크롤백에 1회 commit — 이후 delta 가 와도 repaint 되지 않음. 스트리밍 중인 turn 만 live 영역(`<StatusLine>` 바로 위)에서 repaint. 모든 응답은 `● connected ws://…` 라인 **위쪽**에만 출력.
     - 전역 단축키: Ctrl+D 종료, Ctrl+N 새 세션, Ctrl+L clear (스크롤백은 에뮬레이터 소유 — Static commit 은 남음).
- **출력**: `RpcClient.call('chat.send', params, opts)` + 지속적 UI 재렌더.
- **다음 블록**: [T3] RpcClient

### [T3] RpcClient
- **파일**: [packages/tui/src/lib/rpc-client.ts](D:\ai\agent-platform\packages\tui\src\lib\rpc-client.ts)
- **입력**: `method`, `params`, `CallOptions { onNotification, timeoutMs, signal }`.
- **처리**:
  1. 소켓 미개방이면 `connect()` — `new WebSocket(url, { headers: { Authorization: 'Bearer ${token}' }})`.
  2. `id = nextId++`, `pending.set(id, { resolve, reject, onNotification, timer })`.
  3. `ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))`.
  4. 수신 시 `handleMessage(raw)`:
     - `id==undefined && method` → 서버 notification. `params.requestId` 로 pending 매칭해 per-request `onNotification` 호출. 전역 `opts.onNotification` 도 같이 호출. Notification 종류: `chat.accepted`, `chat.delta`, **`chat.phase`** (ADR-010).
     - `id!==undefined` → `pending.get(id)` 을 `resolve(result)` 또는 `reject(error)`.
  5. 연결 끊기면 지수 백오프 (500ms × 2^attempt, cap 5s, 5회).
- **출력**: `Promise<R>` (최종 RPC 결과). 중간에는 `onNotification` 으로 스트리밍 델타와 phase 이벤트.
- **다음 블록**: WebSocket 프레임 → [G1]

---

## 3. [G1~G3] Gateway 레이어 — 인증 · 디스패치 · chat.send

### [G1] ApiGateway
- **파일**: [packages/control-plane/src/gateway/server.ts](D:\ai\agent-platform\packages\control-plane\src\gateway\server.ts)
- **입력**: HTTP + WebSocket upgrade 요청 (gatewayPort, 기본 18790).
- **처리**:
  - 옵션: `{ port, auth: { tokens }, rateLimit: { capacity, refillPerSecond }, router, sessions, handler }`.
  - 모든 업그레이드 요청에 대해 Bearer 토큰 검증 (`auth.verify`) + 토큰 버킷 레이트리밋.
  - `mount(UpgradeMount)` 로 등록된 path(`/rpc`)면 해당 RpcServer.handleUpgrade 로 위임. 디폴트는 내장 `/ws` envelope 경로.
- **출력**: 인증된 WebSocket → [G2].
- **핵심 API**: `gateway.mount(rpcServer)`, `gateway.start()`, `gateway.stop()`, `gateway.uptimeMs()`.

### [G2] RpcServer
- **파일**: [packages/gateway-cli/src/rpc/server.ts](D:\ai\agent-platform\packages\gateway-cli\src\rpc\server.ts)
- **입력**: 인증된 WebSocket + 메시지 이벤트.
- **처리**:
  1. `handleConnection(ws)` — per-connection `inflight: Map<JsonRpcId, AbortController>` 생성, `connectionId = 'rpc-${counter}'`.
  2. 각 메시지 `parseInbound(raw)` 로 JSON-RPC 프레임 파싱.
  3. `dispatch()`:
     - `methods[req.method]` 미존재 → `errorFrame(MethodNotFound)`.
     - `AbortController` 생성해 `inflight` 에 기록.
     - `RpcContext = { connectionId, requestId, signal, notify(method, params) }`.
     - `await handler(req.params, ctx)` → 성공이면 `successFrame(id, result)`, 예외면 `errorFrame`.
     - 특수: `gateway.shutdown` 은 응답 후 `onShutdownRequested()` 훅 호출.
  4. 소켓 close/error → 모든 `inflight` AbortController abort.
- **출력**: `ws.send(frame)` — response frame 또는 notification frame. `ctx.notify` 가 스트리밍의 트랜스포트.
- **다음 블록**: `methods['chat.send']` → [G3].

### [G3] chat.send RPC Method
- **파일**: [packages/gateway-cli/src/rpc/methods.ts](D:\ai\agent-platform\packages\gateway-cli\src\rpc\methods.ts) (`buildRpcMethods({ gateway, sessions, router, handler, shutdown, version, ports })` 에서 등록)
- **입력**: `params = { text: string, conversationId?, sessionId?, agentId?, channelId?, senderId? }`, `ctx: RpcContext`.
- **처리**:
  1. 파라미터 검증(`requireString` / `optionalString`).
  2. **StandardMessage 구성** (아래 §8.1 참고):
     ```ts
     {
       id: generateId(),
       traceId: generateTraceId(),
       timestamp: nowMs(),
       channel: { type: 'webchat', id: channelIdOverride ?? 'rpc', metadata: {} },
       sender:  { id: senderId ?? 'rpc-client', isOwner: true },
       conversation: { type: 'dm', id: conversationId ?? `rpc-${ctx.connectionId}` },
       content: { type: 'text', text },
     }
     ```
  3. `route = await deps.router.route(msg)` — [C1] 호출.
  4. `ctx.notify('chat.accepted', { requestId, sessionId, agentId, messageId, traceId })` — TUI가 activeSessionId 확정.
  5. **Phase stream 초기화 (ADR-010)**: `turnStart = Date.now()`, `phaseSeq = 0`, `turnClosed = false`. 즉시 `emitPhase('received')` 로 첫 phase 발행.
     ```ts
     const emitPhase = (phase, detail?) => {
       if (turnClosed) return;
       const evt = { turnId: msg.traceId, sessionId, seq: phaseSeq++,
                     at: Date.now(), phase, elapsedMs: Date.now() - turnStart,
                     ...(detail ? { detail } : {}) };
       ctx.notify('chat.phase', { requestId, ...evt });
       if (isTerminalPhase(phase)) turnClosed = true;
     };
     ```
  6. **handlerCtx 구성**:
     ```ts
     {
       sessionId, agentId, traceId,
       emit: (textDelta) => ctx.notify('chat.delta', { requestId, text: textDelta }),
       emitPhase,   // ADR-010 — [P1] / [W1] 이 파이프라인 경계에서 호출
     }
     ```
  7. `usage = await deps.handler(msg, handlerCtx)` — [P1] 호출. (스트리밍은 emit, phase 는 emitPhase 를 통해 진행) 핸들러가 throw 하면 `emitPhase('error', { errorCode: classifyError(err) })` 발행 후 재throw. 정상 종료 시 `emitPhase('finalizing')` → `emitPhase('complete')`.
  8. 반환 `{ requestId, sessionId, agentId, messageId, traceId, usage: {inputTokens?, outputTokens?, costUsd?} }`.
- **출력**: `successFrame` 의 `result` 필드로 직렬화되어 RpcServer.dispatch 가 TUI 로 송신. 턴 라이프사이클 동안 `chat.phase` 다회 + `chat.delta` 다회 동반 전송.
- **프라이버시 경계 (§3.1.4.7)**: phase detail 은 `toolName`/`stepIndex`/`totalSteps`/`egoDecisionId`/`reasoningMode`/`attemptNumber`/`errorCode` 만 허용. 도구 인자·thought 원문·plan 근거·에러 원문은 절대 노출 금지.
- **부가 메서드**: `gateway.health`, `gateway.shutdown`, `chat.history`, `sessions.list`, `sessions.reset`.

---

## 4. [C1~C2''] Control Plane — 라우팅 · 세션 · 레지스트리

### [C1] RuleRouter
- **파일**: [packages/control-plane/src/session/router.ts](D:\ai\agent-platform\packages\control-plane\src\session\router.ts)
- **입력**: `StandardMessage`.
- **처리**:
  1. `rules` 우선순위 정렬. 매치 조건: `channelType`, `senderIsOwner`, `conversationType`, 정규식 등 — 현재 wiring 은 기본 규칙 집합 + `defaultAgentId='default'`.
  2. 매치된 (또는 디폴트) `agentId` 로 `sessionStore.resolveSession(agentId, channelType, conversationId)` 호출.
- **출력**: `RouteDecision = { agentId, sessionId, ruleId? }`.

### [C2] SessionStore
- **파일**: [packages/control-plane/src/session/store.ts](D:\ai\agent-platform\packages\control-plane\src\session\store.ts) (SQLite `better-sqlite3`)
- **주요 메서드** (ADR-010 반영):
  - `resolveSession(agentId, channelType, conversationId)` → `Session` (없으면 INSERT). `resolveSessionWithNewFlag` 로 `isNew` 반환.
  - **공개 계약** (`Contracts.SessionManager` 승격):
    - `appendEvent(sessionId, SessionEventInput)` → INSERT only, autoincrement id 반환. 실패 시 throw (retry 없이 턴 실패로 전파).
    - `loadHistory(sessionId, opts?)` — 시간 오름차순, 기본 `honorCompaction: true` (최신 compaction 이후만), 기본 `includeKinds` 는 `reasoning_step` **제외**.
  - `compactSession(sessionId, keepRecent)` → 요약 이벤트 하나로 폴드.
  - `listSessions({ agentId? })`.
- **`session_events.event_type`** (ADR-010): `user_message | agent_response | tool_call | tool_result | reasoning_step | compaction | system` — `reasoning_step` 은 관측 전용이라 `loadHistory` 기본 쿼리에서 제외된다.
- **DB 경로**: `PlatformConfig.sessionsDbPath` (e.g. `~/.agent/state/sessions.db`).
- **레거시**: `addEvent` / `getRecentEvents` 는 테스트 편의로 남아있으나 런타임 경로는 `appendEvent` / `loadHistory` 를 경유한다.

### [C2'] PlatformChannelRegistry (v0.7 신규)

- **파일**: [packages/control-plane/src/gateway/platform-channel-registry.ts](D:\ai\agent-platform\packages\control-plane\src\gateway\platform-channel-registry.ts)
- **목적**: RPC `channels.list` / `channels.status` 가 반환할 실데이터 소스. `ChannelAdapter` 컨트랙트에 `getStatus()` 같은 신규 메서드를 추가하지 않기 위해 **wrapper 방식**으로 구현 — 어댑터 5개 breaking 없이 status 파생.
- **상태 파생 규칙** (이벤트 기반, 폴링 없음):
  - `register(id, type, adapter)` → `status='connected'`.
  - `recordEvent(id, at?)` → `lastEventAt` 갱신. 이전 error 가 있었다면 자동 clear (`status='connected'`).
  - `recordError(id, error)` → `status='error'` + `error` 텍스트 보존.
  - `deregister(id)` → `status='disconnected'` (엔트리 유지, list 에는 남음).
  - `refreshHealth(id)` (옵셔널, 온디맨드) → `adapter.healthCheck()` 호출해 `healthy===false` 이면 `error`, 예외 발생 시에도 `error` + 예외 메시지.
- **플랫폼 배선** (`packages/cli/src/runtime/platform.ts`):
  1. `const channels = new PlatformChannelRegistry()` — `startPlatform()` 에서 WebChat 초기화 직전 인스턴스화.
  2. `channels.register('webchat', 'webchat', webchat)` — 부팅 직후 등록.
  3. `webchat.onMessage((msg) => { channels.recordEvent('webchat', msg.timestamp); … })` — 메시지 수신 시마다 lastEventAt 갱신.
  4. handler catch 블록에서 `channels.recordError('webchat', err.message)` — 실패 사유 전파.
  5. `PlatformHandles.channels` 로 노출 → `gateway.ts` 가 `RpcDeps.channels = platform.channels` 로 주입.
  6. shutdown 시 `channels.deregister('webchat')` 먼저 호출해 status='disconnected' 로 전환.
- **구조적 호환성**: `list(): readonly ChannelDescriptor[]` / `get(id)` 는 gateway-cli 의 `ChannelRegistry` 인터페이스와 필드-by-필드 동일 → 어댑터 불필요, 그대로 할당 가능.
- **확장 지점**: Telegram/Slack/Discord/WhatsApp 어댑터가 platform 기동 경로에 합류하면 동일 패턴으로 `channels.register(…)` 한 줄씩 추가.

### [C2''] SchedulerService (v0.7 신규 — CronRegistry 실구현, option B)

- **파일**: [packages/scheduler/src/scheduler.ts](D:\ai\agent-platform\packages\scheduler\src\scheduler.ts) (+ `runners/chat-runner.ts`, `runners/bash-runner.ts`, `runners/workflow-runner.ts`, `json-task-store.ts`, `types.ts`)
- **목적**: RPC `cron.list` / `cron.runNow` 실데이터 공급 + 3종 작업 타입 (chat / bash / workflow) 을 주기적으로 디스패치.
- **CronTask discriminated union**:
  ```ts
  type CronTask =
    | { id; spec; enabled; type: 'chat';     chat:     ChatTaskConfig }
    | { id; spec; enabled; type: 'bash';     bash:     BashTaskConfig }
    | { id; spec; enabled; type: 'workflow'; workflow: WorkflowTaskConfig };
  ```
- **저장소**: `<stateDir>/scheduler/tasks.json` (JSON5 스타일 — 주석/trailing comma 허용, 중복 id 거절). 파일 부재 시 빈 배열로 부팅. v1 은 RPC mutation 없음 — 편집 후 gateway 재시작.
- **TaskRunner 경로**:
  - `ChatTaskRunner`: `router.route(msg)` → `handler(msg, ctx)` 직접 호출. `handler` 가 EGO 를 이미 감싸므로 스케줄된 턴도 `[P1]` 을 그대로 경유 (JSON-RPC `chat.send` 와 동일 플로우). `sessionStrategy: 'pinned'` (default) 면 `cron-<taskId>` 세션에 대화 이력 누적, `'fresh'` 면 매 실행마다 새 conversationId.
  - `BashTaskRunner`: `capabilityGuard.check()` → `toolSandbox.acquire(ownerPolicy('cron-<taskId>'))` → `execute('bash.run', {command, cwd?}, timeoutMs)` → `release`. **직접 `child_process.spawn` 금지** — 에이전트 `bash.run` 과 동일 샌드박스·정책 경로 상속.
  - `WorkflowTaskRunner`: `validateWorkflow(JSON.parse(file))` → sandbox 1회 acquire → `WorkflowToolAdapter` shim 이 `executeWorkflow` 의 tool_call 을 `capabilityGuard.check()` + `toolSandbox.execute()` 로 bridge. 워크플로우 전체가 하나의 sandbox 인스턴스를 공유 (per-tool_call 획득 비용 회피).
- **node-cron 스케줄링**: `start()` 시 enabled 태스크마다 `cron.schedule(spec, fireHandler)` 등록. `spec` 이 `cron.validate()` 실패 또는 runner 미등록이면 fast-fail.
- **동시성 정책** (단일동시성 per task id):
  - `dispatch()` 진입 시 `history.running===true` 면 skip (log-and-continue — 스케줄된 fire 가 이전 실행과 겹침).
  - `runNow(id)` 는 동일 조건에서 **throw** (`already running`) — 호출자가 명시적으로 알 수 있게.
- **실행 이력 (인메모리, 재시작 시 초기화)**: `Map<taskId, { lastRunAt, lastRunMs, lastError, running, runCount }>`. v1 스코프 — 영구 보존은 필요해지면 SQLite 로 승급.
- **상태 파생** (`list()` → `CronTaskDescriptor`):
  - `!enabled` → `disabled`
  - `running` → `running`
  - `lastError` 존재 → `error`
  - 그 외 → `idle`
- **onRun 훅**: 성공·실패 공히 완료 직후 `SchedulerRunEvent { taskId, type, trigger, startedAt, finishedAt, ok, summary?, error? }` 를 콜백으로 발행 — 테스트 + 향후 trace-logger 통합 지점.
- **구조적 호환성**: `list(): readonly CronTaskDescriptor[]` / `runNow(id)` 는 gateway-cli 의 `CronRegistry` 인터페이스와 동일 shape — `RpcDeps.cron = platform.scheduler` 로 어댑터 없이 주입.

---

## 5. [P1] Platform handler — EGO + AgentRunner 오케스트레이션

- **파일**: [packages/cli/src/runtime/platform.ts](D:\ai\agent-platform\packages\cli\src\runtime\platform.ts) (`startPlatform()` 내부의 `handler: MessageHandler`)
- **입력**: `(msg: StandardMessage, ctx: { sessionId, agentId, traceId, emit(text), emitPhase?(phase, detail?) })`.
- **처리** (withSpan `'platform.handleTurn'` 으로 래핑):
  1. **Phase `ego_judging` emit (ADR-010)**: `ctx.emitPhase?.('ego_judging')` — EGO 파이프라인 진입 직전 1회. EGO state==='off' 이어도 핸들러 수락 후 첫 내부 경계를 표시하는 역할.
  2. **EGO 판단** (withSpan `'platform.ego'`): `record = await ego.processDetailed(msg, { sessionId, agentId })`.
  3. `metrics.recordEgoDecision({ fastExit, action, confidence, costUsd, pipelineMs })`.
  4. **direct_response 분기**: `ctx.emit(text)` 한 번 호출 후 `return {}` — AgentRunner 비호출. [G3] 가 이후 `finalizing`+`complete` 를 발행하므로 별도 phase emit 불필요.
  5. **enrich / passthrough 분기**:
     - `baseMsg = (action==='enrich' ? decision.enrichedMessage : msg)`. enrich 경로는 이미 `channel.metadata._egoEnrichment` + `_egoDecisionId` 가 부착됨.
     - `effectiveMsg` = baseMsg + `channel.metadata._egoPerception` + `_egoCognition` (+ `_egoGoalUpdates` 가 비어있지 않으면 포함) — ComplexityRouter 와 `PlanExecuteExecutor` 가 직접 읽을 수 있게 EGO `thinking` 결과를 리프트. `_egoCognition` / `_egoGoalUpdates` 는 v0.7 신규로 replan 트리거 #3 에서 소비.
  6. **Agent 턴** (withSpan `'platform.agent'`): `result = await runner.processTurn(ctx.sessionId, effectiveMsg, ctx.emit, ctx.emitPhase)` — 4번째 인자로 phase 콜백을 그대로 전달.
  7. `metrics.recordTurn({ ... inputTokens, outputTokens, estimatedCostUsd, firstTokenLatencyMs, totalLatencyMs, ... })`.
- **출력**: `{ inputTokens?, outputTokens?, costUsd? }`.
- **배선 상수**: `ownerPolicy('__default__')` 단일 인스턴스, `InProcessSandbox(toolMap)`, `PolicyCapabilityGuard(policies, toolMap)` (lazy `ownerPolicy(sessionId)` populate).

### 동일 handler 의 다른 엔트리
- 본 문서는 TUI 경로를 추적하지만, 같은 `handler` 가:
  - WebChatAdapter (`packages/channels/webchat`) → `webchat.onMessage` → `router.route` → `handler(msg, { …, emit: webchat.emitDelta })` 경로로도 호출됨.
  - ApiGateway 내장 `/ws` envelope 경로 (`packages/control-plane/src/gateway/server.ts` 의 디폴트 mount).
- 즉 `[P1]` 은 모든 채널이 수렴하는 단일 진입점이다.

---

## 6. [E1] EGO 레이어 — S1~S7 파이프라인 + 판단 네 가지

### [E1] EgoLayer
- **파일**: [packages/ego/src/layer.ts](D:\ai\agent-platform\packages\ego\src\layer.ts) `processDetailed()`
- **설계 매핑**: `ego-design.md` §5 "Two-tier 파이프라인" — S1(intake) + S2(normalize) 는 fast path, S3(perception) + S4(cognition) + S5(judgment) 는 단일 LLM 호출로 퓨전, S6(materialize) + S7(audit) 이 후처리.
- **입력**: `(msg, { sessionId, agentId, recentHistory? })`.
- **처리 단계**:
  - **S1. intake** ([signal.ts](D:\ai\agent-platform\packages\ego\src\signal.ts)) → raw signal.
  - **S2. normalize** ([normalize.ts](D:\ai\agent-platform\packages\ego\src\normalize.ts)) → `NormalizedSignal { intent, complexity, urgency, sentiment, entities, rawText, traceId, … }`.
  - **Operational 체크**: `state==='off'` → 즉시 `passthrough`.
  - **Fast exit 체크** (ADR v0.6): `config.fastPath.enabled !== false && shouldFastExit(normalized, config)` true → passthrough, audit 기록 후 return. `fastPath.enabled: false` (ego.json) 또는 `EGO_FORCE_DEEP=1` 환경변수로 fast path 자체를 꺼서 **모든 턴이 deep path** 로 진입하도록 강제할 수 있음 (ego/src/config.ts `applyEnvOverrides`).
  - **LLM / 서킷 체크**: `deps.llm` 미주입 또는 `breaker.allow()==false` → passthrough + `ego.deep_path_skipped` audit.
    - 기본 배선: `createEgoLlmAdapter(egoConfig.llm)` ([packages/ego/src/llm-adapter-factory.ts](D:\ai\agent-platform\packages\ego\src\llm-adapter-factory.ts)) 가 provider 에 맞는 어댑터를 인스턴스화한다. `provider: 'openai'` → `OpenAiEgoLlmAdapter` (native `response_format: json_object` 사용), `'anthropic'` → `AnthropicEgoLlmAdapter`. `egoConfig.llm.fallback` 이 있으면 두 어댑터를 `FallbackEgoLlmAdapter` 데코레이터로 합성 (primary.think 실패 시 fallback.think).
    - 기본 provider: **OpenAI** + `gpt-4o-mini` + `${OPENAI_API_KEY}` (gateway.ts `defaultActiveEgoConfig`). API key 미설정 시 gateway 는 hard-fail. `baseURL` 은 OpenAI-compatible 엔드포인트(Ollama 등)에 접속할 때 지정.
  - **Deep path** (`runDeepPath`, withTimeout `maxDecisionTimeMs`):
    - **S3/S4 컨텍스트 수집**: `gatherContext({ signal, memory, goals, recentHistory, persona, audit, traceId })` — [X1] MemorySystem, [X2] GoalStore, SessionStore history, audit 접근.
    - **Persona snapshot**: `deps.persona.snapshot({ rawText, entities })` → 프롬프트에 병합.
    - **System prompt**: `buildSystemPrompt(base, personaSnapshot)`.
    - **S5 LLM 호출**: `deps.llm.think({ systemPrompt, context, responseFormat: { type: 'json_object' } })`. provider-agnostic — OpenAI 경로는 native JSON 모드 enforcement + reasoning-model 감지 (`gpt-5.x` / `o1-o4` → `max_completion_tokens` + temperature/top_p 제외), Anthropic 은 prompt-only JSON 강제 + text 추출.
    - **프롬프트 그라운딩** (v0.5): `buildUserPrompt` ([packages/ego/src/llm-adapter-shared.ts](D:\ai\agent-platform\packages\ego\src\llm-adapter-shared.ts)) 가 `SCHEMA` 블록(`Schemas.EgoThinkingSchema.EgoThinkingResult` 직렬화) + `CONTEXT` 블록 + action-contingent 필수 필드 규칙(enrich→enrichment, redirect→redirect.{targetAgentId,targetSessionId,reason}, direct_response→directResponse.text)을 명시. `response_format: json_object` 가 문법만 강제하는 제약을 프롬프트로 보완.
    - **검증**: `validateEgoThinking(raw)` — schema 위반 시 `SchemaValidationError` → fallback passthrough. 던지는 에러는 `classifyValidationFailure` 가 계산한 실제 `tag` (`llm_invalid_json` / `llm_schema_mismatch` / `llm_out_of_range` / `llm_inconsistent_action` / `llm_invalid_target`) 와 파싱된 invalid `candidate` 를 보존해 하류 observability 에서 구체 분류·원인 지목 가능 (v0.5 이전에는 tag 하드코딩 `llm_schema_mismatch`).
    - **브레이커 성공 기록**: `breaker.recordSuccess()`.
    - **비용 회계**: `ledger.add(costUsd)` 가 `maxCostUsdPerDay` 초과 시 → `state` 자동 다운그레이드 (`active→passive→off`) + `DailyCostCapExceeded`.
    - **임계 신뢰도 체크**: `judgment.confidence < minConfidenceToAct` → action 을 `passthrough` 로 override.
    - **Passive state 마스킹**: `isIntervening(state)==false` 면 action 을 `passthrough` 로 강제 (판정은 기록).
    - **S6 materialize** (`materializeDecision`):
      - `passthrough` → `{ action: 'passthrough' }`.
      - `enrich` → `{ action:'enrich', enrichedMessage: { …msg, channel.metadata._egoEnrichment = judgment.enrichment, _egoDecisionId } }`. `enrichment.suggestTools` (string 배열) 는 AgentRunner 의 `extractEgoEnrichment` 가 `suggestedTools` 로 추출 → PromptBuilder 가 system prompt 에 `## EGO 추천 도구` 블록을 자동 주입 (availableTools 재정렬은 하지 않음 — 미등록 도구가 추천돼도 silent 무시가 안전).
      - `redirect` → `performRedirect(…)` 로 타겟 세션/에이전트에 이관 후 `{ action:'redirect', targetAgentId, targetSessionId, reason }`.
      - `direct_response` → `{ action:'direct_response', content:{type:'text', text}, reason }`.
    - **S7 audit**: `auditDecision(…)` 으로 `ego_decision` 이벤트 기록 + confidence / egoRelevance parameters.
- **출력**: `ProcessRecord { decision, normalized, fastExit, thinking?, metadata?, costUsd, pipelineMs }`.
- **에러 처리 & 태깅** (v0.5):
  - `processDetailed` 의 catch 블록은 `err` 를 세 부류로 분기해 audit/trace 태그를 결정한다:
    - `SchemaValidationError` → `err.tag` 그대로 사용 (`llm_invalid_json` / `llm_schema_mismatch` / `llm_out_of_range` / `llm_inconsistent_action` / `llm_invalid_target`).
    - `TimeoutError` ([core/time.ts](D:\ai\agent-platform\packages\core\src\time.ts), `withTimeout` 이 budget 초과 시 throw) 또는 `EgoTimeoutError` → `ego_timeout`.
    - 그 외 → `ego_runtime_error` (fallback).
  - 같은 catch 블록이 `traceLogger.event({ block:'E1', event:'error', payload: buildErrorPayload(err, tag) })` 를 호출 — payload 에 `tag` 가 항상 들어가고, `SchemaValidationError` 인 경우 `validationErrors`(path+message, 5건 cap) 와 `candidatePreview` (800자 cap, 파싱된 invalid 객체를 JSON 직렬화) 가 함께 기록된다. `fallbackOnError: true` 면 passthrough 로 degrade.
  - `withTimeout` 이 v0.5 이전에는 plain `Error` 를 던졌고 catch 블록은 `EgoTimeoutError instanceof` 로만 체크했기 때문에 모든 pipeline/memory-search 타임아웃이 silent 하게 `ego_runtime_error` 로 분류되는 회귀가 있었음 — `TimeoutError` 도입으로 정정.

### EGO 컴패니언 블록
- **[X1] MemorySystem** — `PalaceMemorySystem` ([packages/memory/src/palace-memory.ts](D:\ai\agent-platform\packages\memory\src\palace-memory.ts)). `gatherContext` 가 `memory.search()` 로 관련 기억 인출 + `agent-runner` 가 `memory.ingest()` 로 매턴 기록.
- **[X2] GoalStore** — `FileGoalStore`. 활성 목표 로드.
- **[X3] PersonaManager** — `FilePersonaManager`. snapshot 텍스트 생성.
- **[X4] AuditLog** — `SqliteAuditLog`. 모든 EGO 결정 기록.
- **[X5] CircuitBreaker** — 연속 실패 시 LLM 호출 차단.

---

## 7. [W1] AgentRunner — 프롬프트 빌드 · 리즈너 위임 · 스트리밍

### [W1] AgentRunner.processTurn
- **파일**: [packages/agent-worker/src/runner/agent-runner.ts](D:\ai\agent-platform\packages\agent-worker\src\runner\agent-runner.ts)
- **입력**: `(sessionId, msg: StandardMessage, onChunk?(text), onPhase?(phase, detail?))`. 4번째 인자는 ADR-010 TUI Phase Event Stream 용 콜백 — [P1] 이 `ctx.emitPhase` 를 그대로 전달.
- **처리** (ADR-010 + U10 반영):
  1. `session_resolved` 관측 — `sessionStore.getSession(sessionId)` 로 `isNew` 판정 후 발행.
  2. `userText = extractText(msg)` — content.type 에 따라 text/command/media/reaction 분기.
  3. `enrichment = extractEgoEnrichment(msg)` (`_egoEnrichment` 메타 — `addContext` / `addInstructions` / `memories` / `suggestedTools` 추출), `egoDecisionId = extractEgoDecisionId(msg)`, `egoPerception = extractEgoPerception(msg)`.
  4. `events = sessionStore.loadHistory(sessionId, { limit: 50 })` — ADR-010 공개 계약. `reasoning_step` 은 기본 제외됨 → `history_loaded eventCount=N` 관측.
  5. `PromptBuilder.build({ systemPrompt: config.systemPrompt, sessionEvents: events, userMessage: userText, egoEnrichment })` → `{ systemPrompt, messages[] }`. `suggestedTools` 가 있으면 `## EGO 추천 도구` 블록이 system prompt 에 주입. compaction 이벤트는 systemPrompt 에 요약 블록으로 합류 (1건만).
  6. `priorMessages = messages.slice(0, -1)` (마지막 user 는 ReasoningContext.userMessage 로 다시 주입).
  7. `availableTools = deps.toolRegistry?.descriptors() ?? deps.tools ?? []` — **LiveToolRegistry 스냅샷** (U10 Phase 4). 이전 턴의 `skill.create` 결과가 이 지점에서 처음 노출됨.
  8. 리즈너 선택: `deps.reasoner ?? new ReactExecutor(modelAdapter, { capabilityGuard, toolSandbox, sessionPolicy })`.
  9. **Phase `reasoning_route` emit (ADR-010)**: `onPhase?.('reasoning_route', { reasoningMode: reasoner.mode })` — reasoner.run 직전. 이후 phase 전이는 ReasoningEvent 스트림이 주도.
  10. 플래그 초기화: `replanAttempts = 0`, `streamingPhaseEmitted = false`.
  11. `ReasoningContext` 조립 (아래 §8.4) 후 `for await (ev of reasoner.run(ctx))`:
      - `delta` → 첫 delta 에서 `onPhase?.('streaming_response')` 1회(guard 로 재진입 차단). `responseText += ev.text; onChunk?.(ev.text)`.
      - `usage` → `inputTokens/outputTokens/cost`.
      - `step` → `appendEvent({ eventType:'reasoning_step', ... })` best-effort. 추가로 **ReasoningStep → Phase 매핑**:
        - `step.kind === 'tool_call'` → `onPhase?.('tool_call', { toolName: readToolName(step.content) })` (args 는 절대 forward 안 함)
        - `step.kind === 'plan'` → `onPhase?.('planning')`
        - `step.kind === 'replan'` → `replanAttempts += 1; onPhase?.('replan', { attemptNumber: replanAttempts })`
      - `final` → 비어있지 않으면 `responseText = ev.text`.
  12. **턴 종결 append** (ADR-010 원자성): `appendEvent(user_message)` + `appendEvent(agent_response)` 를 한 try/catch 로. 실패 시 `session_append_failed` 감사 로그 + throw (메모리 ingest · 메타 갱신 건너뜀). 성공 시 `session_events_appended appendedCount=2` 관측.
  13. `memory.ingest({ sessionId, userMessage, agentResponse, timestamp })` (best-effort).
- **출력**: `TurnResult { responseText, inputTokens, outputTokens, costUsd?, latencyMs, ingested }`. Phase 의 `finalizing`/`complete`/`error` 는 [W1] 이 아닌 [G3] 가 발행.
- **W1 관측 이벤트 canonical** (`TraceEventNames`): `session_resolved` · `history_loaded` · `prompt_built` · `reasoner_invoked` · `stream_done` · `session_events_appended` · `session_append_failed` · `memory_ingested`.
- **미구현(ADR-010 후속)**: `waiting_tool` phase — react-executor 가 샌드박스 acquire/release 경계를 ReasoningEvent 로 노출하지 않음. `executing_step.stepIndex/totalSteps` — plan-execute reasoner 가 단계 경계 이벤트를 노출할 때 활성화.

### [W2] PromptBuilder
- **파일**: `packages/agent-worker/src/prompt/builder.ts`
- **입력**: `{ systemPrompt, sessionEvents, userMessage, egoEnrichment? }`. `egoEnrichment.suggestedTools?: string[]`.
- **처리** (ADR-010 매핑 규약):
  - system prompt 기본: `config.systemPrompt` 미지정 시 built-in default. gateway 는 `~/.agent/system-prompt.md` 가 있으면 그 내용을 주입.
  - EGO enrichment 블록: `## EGO 맥락` (addContext) + `## 관련 기억` (memories) + `## EGO 지시` (addInstructions) + **`## EGO 추천 도구`** (suggestedTools) 순.
  - 세션 이벤트 매핑: `user_message→role:'user'`, `agent_response→role:'assistant'`, `tool_result→role:'tool'` (toolCallId 포함), `compaction→systemPrompt 말미에 합류 (1건만)`, `reasoning_step→방어적 드롭`.
- **출력**: `{ systemPrompt, messages: CompletionMessage[] }`.

---

## 8. [R1~R3] Reasoning 레이어 — Hybrid/ReAct/Plan-Execute

### [R1] HybridReasoner
- **파일**: [packages/agent-worker/src/reasoning/hybrid-reasoner.ts](D:\ai\agent-platform\packages\agent-worker\src\reasoning\hybrid-reasoner.ts)
- **입력**: `ReasoningContext` (§8.4).
- **처리**:
  1. 생성 시 `ReactExecutor` 는 항상 생성. `PlanExecuteExecutor` 는 `capabilityGuard && toolSandbox && sessionPolicy` 가 모두 주입되고 `disablePlanExecute!=true` 일 때만 생성.
  2. `run(ctx)` 에서 `DefaultComplexityRouter.select({ userMessage, availableTools, egoPerception })` → `'react' | 'plan_execute'`.
  3. plan_execute 이지만 `planExecute===undefined` 면 react 로 폴백.
  4. `yield* executor.run(ctx)`.
- **출력**: `AsyncIterable<ReasoningEvent>`.

### [R1a] DefaultComplexityRouter
- **파일**: `packages/agent-worker/src/reasoning/complexity-router.ts`
- **입력**: `{ userMessage, availableTools, egoPerception? }`.
- **처리**: `egoPerception` 의 `requestType` / `estimatedComplexity` / `requiresToolUse` 를 우선 사용. 없으면 텍스트 길이·키워드 휴리스틱. 도구 없으면 항상 `'react'`.
- **출력**: `'react' | 'plan_execute'`.

### [R2] ReactExecutor
- **파일**: `packages/agent-worker/src/reasoning/react-executor.ts`
- **입력**: `ReasoningContext`.
- **처리** (ReAct 루프):
  1. 초기 messages = priorMessages + user.
  2. `canExecuteTools = (availableTools.length>0 && capabilityGuard && toolSandbox && sessionPolicy)`.
  3. `maxSteps` / `maxToolCalls` 까지 루프:
     - `modelAdapter.stream({ systemPrompt, messages, tools: canExecuteTools ? toolDefs : undefined })`.
     - 각 chunk 별 `yield { kind:'delta', text }`.
     - 응답 완료 후 tool_calls 파싱:
       - 각 호출 `capabilityGuard.check(sessionId, name, args)` → 허가되면 `toolSandbox.invoke(…)` → observation 을 다음 턴 message 에 append.
       - 거부 시 denial observation.
     - tool 호출 없으면 종료.
  4. 최종 `yield { kind:'final', text }` + `yield { kind:'usage', inputTokens, outputTokens, cost }`.
- **출력**: `AsyncIterable<ReasoningEvent>`.

### [R3] PlanExecuteExecutor
- **파일**: `packages/agent-worker/src/reasoning/plan-execute-executor.ts`
- **입력**: `ReasoningContext` (+ 생성자에 `plannerModel` 주입 가능).
- **처리**:
  1. `planner` 호출 (별도 system prompt 로 JSON plan 강제). 파싱 실패 → ReAct 다운그레이드.
  1b. **트리거 #3 (v0.7 신규)**: `ctx.egoCognition?.egoRelevance > 0.8 && (ctx.goalUpdates?.length ?? 0) > 0` 이면 plan 형성 직후 즉시 재계획 1회. 전용 prompt 가 이전 plan + goalUpdates 리스트 + `cognition.opportunities/risks/situationSummary` 를 surface — planner 가 목표 변경을 반영해 새 plan 을 생성. `replanLimit` 과 공유되므로 트리거 #1 (retry 소진) 과 합쳐 상한 초과 없음. replan 마커 `reason: 'goal_updates_high_relevance'` + 성공 step 보존 규칙 동일.
  2. `computeLevels(plan.steps)` — 의존성 그래프로 레벨 분리.
  3. 각 레벨:
     - `parallelExecution: true` → 동일 레벨 step 을 `Promise.all`, 이벤트는 step 순서대로 버퍼링 후 일괄 yield (trace 결정성 유지).
     - 기본 false → 순차 실행.
     - 각 step: 내부적으로 `ReactExecutor` 호출 + tool 실행. 실패 시 `stepRetryLimit` 재시도.
  4. 단계 실패 누적 → `replanLimit` 회 replan. replan 시 동일 id 성공 step 은 status/observation 자동 승계 (재실행 방지).
  5. 모든 한도 소진 → ReAct 로 augmented user message + fresh budget 다운그레이드.
  6. 완료 후 summary (최종 텍스트) `yield { kind:'final', text }` + usage.
- **출력**: `AsyncIterable<ReasoningEvent>` (`delta`, `usage`, `final`, 내부 trace 이벤트).
- **참고**: `agent-orchestration.md` §2 참조. 현재 replan 트리거 #1 (retry 소진) + #3 (egoRelevance>0.8 + goalUpdates) 구현. #2 (LLM judge) 는 LLM 추가 호출 비용 부담으로 보류.

### §8.4 주요 데이터 쉐이프

#### StandardMessage (core/schema)
```ts
{
  id: string;
  traceId: string;
  timestamp: number;          // epoch ms
  channel: { type, id, metadata: Record<string, unknown> };
  sender:  { id, isOwner: boolean, displayName? };
  conversation: { type: 'dm'|'group'|'channel', id };
  content: { type: 'text', text } | { type: 'command', name, args } |
           { type: 'media', … } | { type: 'reaction', emoji };
}
```
- **Enrichment convention**: `channel.metadata` 에 `_egoEnrichment`, `_egoDecisionId`, `_egoPerception`, `_egoCognition`, `_egoGoalUpdates` 가 부착될 수 있음 (EGO→Runner). `_egoCognition` 과 `_egoGoalUpdates` 는 v0.7 신규 — `PlanExecuteExecutor` 트리거 #3 가 소비.

#### EgoDecision (판별 유니온)
```ts
| { action: 'passthrough' }
| { action: 'enrich', enrichedMessage: StandardMessage, metadata? }
| { action: 'redirect', targetAgentId, targetSessionId, reason }
| { action: 'direct_response', content: { type: 'text', text }, reason }
```

#### ReasoningContext (Contracts)
```ts
{
  sessionId, agentId,
  userMessage: StandardMessage,
  systemPrompt: string,
  priorMessages: { role, content }[],
  availableTools: ToolDescriptor[],
  egoDecisionId?: string | null,
  egoPerception?: Perception,   // ComplexityRouter 직접 소비
  egoCognition?: Cognition,     // v0.7 — PlanExecuteExecutor 트리거 #3 게이팅
  goalUpdates?: GoalUpdate[],   // v0.7 — 트리거 #3 의 변경 목표 surface
  traceLogger?: TraceLogger,
}
```

#### ReasoningEvent (스트림 이벤트)
```ts
| { kind: 'delta', text }
| { kind: 'usage', inputTokens, outputTokens, cost? }
| { kind: 'final', text }
| { kind: 'trace', ...(내부 디버깅용) }
```

---

## 9. [M1][S1][K1] 모델 어댑터 & 샌드박스 & 라이브 레지스트리

### [M1] ModelAdapter
- **파일**: [packages/cli/src/runtime/model-adapter.ts](D:\ai\agent-platform\packages\cli\src\runtime\model-adapter.ts) + `packages/agent-worker/src/model/`.
- **입력**: `CompletionRequest { systemPrompt, messages, tools?, maxTokens?, temperature? }`. `messages[].toolCalls?` 는 assistant 턴이 이전 턴에서 호출한 도구를 replay 할 때 사용.
- **처리**:
  - Anthropic SDK / OpenAI SDK streaming API 호출.
  - **Tool name sanitize** (`packages/agent-worker/src/model/tool-name.ts`): OpenAI/Anthropic 이 `^[a-zA-Z0-9_-]+$` 패턴만 허용하므로 canonical `fs.read` → wire `fs_read` 로 변환. `buildToolNameMap` 이 양방향 맵 보유 — canonical 이름 충돌 시 throw. `tool_call_start` 이벤트 수신 시 wire 이름을 다시 canonical 로 복원해 downstream `sandbox.execute` 는 `fs.read` 를 그대로 받음.
  - **Assistant toolCalls 직렬화**: CompletionMessage 의 `role:'assistant' + toolCalls:[…]` 을 OpenAI `tool_calls:[{id,type:'function',function:{name:sanitized,arguments}}]` / Anthropic `content:[{type:'text'},{type:'tool_use',id,name:sanitized,input}]` 블록으로 변환. 이 덕분에 OpenAI 의 "messages with role 'tool' must be a response to a preceding message with 'tool_calls'" 400 에러를 회피.
  - **Reasoning-model 분기**: OpenAI adapter 가 `gpt-5.x` / `o1-o4` 를 감지하면 `max_tokens` → `max_completion_tokens`, `temperature` · `top_p` 제외. EGO LLM adapter 도 동일 분기.
- **출력**: `AsyncIterable<StreamChunk>` (`text_delta`, `tool_call_start/delta/end`, `usage`, `done`).

### [S1] ToolSandbox + CapabilityGuard
- **파일**: `packages/agent-worker/src/security/capability-guard.ts` + `packages/agent-worker/src/tools/sandbox.ts`.
- **플랫폼 배선** (platform.ts):
  ```
  liveRegistry = new LiveToolRegistry()
  liveRegistry.registerAll(buildDefaultTools(defaultToolsConfig))  // fs.read/fs.list/fs.write/web.fetch
  liveRegistry.registerAll(config.tools ?? [])                     // user 오버라이드
  liveRegistry.registerAll(skillAuthoringTools({ registry, remount }))  // enableSkillAuthoring
  await remountInstalledSkills()                                   // 기 설치된 skill tool
  toolMap = liveRegistry.asMap()                                   // ← live reference
  innerGuard = new PolicyCapabilityGuard(policies, toolMap)
  toolSandbox = new InProcessSandbox(toolMap)
  ```
  `asMap()` 이 **live reference** 라, skill.create 이후 `liveRegistry.register(newTool)` 이 일어나면 sandbox/guard 는 수정 없이도 새 도구를 인식한다.
- **입력**: `(sessionId, toolName, args)` — ReactExecutor 가 각 tool_call 에 대해 호출.
- **처리**: `PolicyCapabilityGuard.check` 이 session policy 를 lazy-populate (owner trust 기본). deny/grant 리스트 → tool permission 검사 (`filesystem.write` · `process.execute` 는 owner trust 필수). 허가 시 `tool.execute(args, ctx)` 를 in-process 에서 실행. Docker 샌드박스는 `bashTool` 등 `runsInContainer: true` 도구에서만 사용.
- **출력**: `ToolResult { toolName, success, output?, error?, durationMs }`.

### [K1] LiveToolRegistry + LocalSkillRegistry (U10)
- **파일**:
  - [packages/agent-worker/src/tools/live-registry.ts](D:\ai\agent-platform\packages\agent-worker\src\tools\live-registry.ts)
  - [packages/agent-worker/src/tools/skill-tools.ts](D:\ai\agent-platform\packages\agent-worker\src\tools\skill-tools.ts)
  - [packages/skills/src/local-registry.ts](D:\ai\agent-platform\packages\skills\src\local-registry.ts) + `loader.ts` + `tool-registrar.ts`
- **역할**: base + user + skill-authoring + 기 설치된 skill 을 단일 Map 으로 consolidate 하는 **mutable 도구 레지스트리** + 디스크 기반 **스킬 패키지 레지스트리**.
- **기본 도구 세트** (buildDefaultTools preset):
  - `fs.read(path)` — allow-list 경로 내 UTF-8 파일 읽기 (low risk, filesystem.read perm).
  - `fs.list(path)` — 디렉토리 엔트리 열거 (low risk, fsRead 와 roots 공유).
  - `fs.write(path, content)` — allow-list 내 파일 쓰기 (medium risk, filesystem.write → owner-trust 필수).
  - `web.fetch(url)` — 도메인 allow-list 대상 HTTP (medium risk, 기본 OFF).
- **스킬 authoring 도구 (enableSkillAuthoring=true 시)**:
  - `skill.create({id, name, description, sourceCode, permissions, …})` — **high risk**, `filesystem.write: [~/.agent/skills]` perm. sourceCode 는 `staticCheckSource` 정적 검사 (eval/new Function/child_process/require/dynamic import 금지, import allow-list: `node:*` + `@agent-platform/*`). 통과 시 `LocalSkillRegistry.installFromDefinition(def)` 호출 — staging dir 에 `index.js` + `manifest.json` (contentSha256 자동, signingSecret 있으면 HMAC 자가서명) 생성 → 검증 → `~/.agent/skills/<id>/` 로 cp → `remount()` 콜백 호출.
  - `skill.list({query?})` — 설치된 skill 열거.
  - `skill.remove({id})` — medium risk, `LocalSkillRegistry.uninstall(id)` + remount.
  - `skill.reload()` — 디스크 변경을 LiveToolRegistry 에 다시 반영.
- **Remount 흐름**: `mountInstalledSkills(registry)` 가 설치된 각 skill 의 `manifest.json` 을 읽고 `loadSkillTools(manifest, installDir)` 로 entryPoint 를 import → `LoadedSkillTool[]` 수집. `assertSafeEntryPoint(installDir, entryPoint)` 가 `..` · 절대경로 · URL · 설치 dir 외부를 거부. platform.ts 의 `adaptSkillTool` 이 `LoadedSkillTool → AgentTool` 로 shape 보정 후 `liveRegistry.registerAll(...)`.
- **Handler 정규화** (v0.5): skill 저자가 정의한 tool 이 `execute(args, ctx)` 또는 레거시 alias `call(args, ctx)` 중 하나를 가지면 `loadSkillTools` 가 호출 지점을 항상 `execute` 로 노출(internal `normalizeToolHandler`). 다른 필드(`description`/`permissions`/`riskLevel`/`inputSchema`/`runsInContainer`/`dockerCommand`)는 그대로 보존. 둘 다 없으면 `skill <id>: tool '<name>' must expose an execute(args, ctx) method (or legacy call())` 로 throw. 새 스킬은 `execute` 를 쓰는 게 규약이며 `skill.create` 의 `sourceCode` description 도 이를 명시.
- **다음 턴 노출**: `skill.create` 로 만든 도구는 **현재 턴에서는 사용 불가** (PromptBuilder 가 턴 시작 시 availableTools 를 system prompt 에 박아버림). 응답에 "다음 메시지부터 `<toolName>` 사용 가능" 을 명시. 다음 턴에 `AgentRunner` 가 `toolRegistry.descriptors()` 스냅샷을 새로 찍으면서 자연스럽게 노출.
- **보안 경계**:
  - owner-trust 는 `PolicyCapabilityGuard.filesystem.write` 정책으로 자동 강제 (non-owner 세션은 `skill.create`/`skill.remove` 호출 자체가 거부).
  - entryPoint traversal 가드는 `loader.ts` 의 `loadSkillTools` 가 import 직전 호출.
  - staticCheckSource 는 우발적 공격 표면 축소 (완벽한 sandbox 는 아님 — InProcessSandbox 는 "not a security boundary" 명시).
  - 후속 과제: DockerSandbox 로 skill 실행 이관 (`LoadedSkillTool.runsInContainer` 인터페이스 이미 존재).

### [K2] seedBuiltinSkills + 내장 스킬 (U11, v0.4 · v0.5 확장)
- **파일**: [packages/skills/src/bootstrap.ts](D:\ai\agent-platform\packages\skills\src\bootstrap.ts), [packages/skills/builtin/](D:\ai\agent-platform\packages\skills\builtin)
- **역할**: 리포지토리에 번들된 first-party 내장 스킬을 gateway 기동 시 `~/.agent/skills/<id>/` 로 idempotent 복사 — 이후 `mountInstalledSkills` 가 일반 설치본과 동일 경로로 툴을 노출.
- **호출**: [P1] platform.ts 에서 `skillRegistry` 생성 직후, `skillAuthoringTools` 등록 전, `remountInstalledSkills()` 전에 한 번.
  ```ts
  const seedResult = await seedBuiltinSkills(config.skillInstallRoot,
                                             BUILTIN_SKILLS_ROOT,
                                             { logger });
  // → { seeded: [...], upgraded: [...], skipped: [...] }
  ```
- **규약**:
  - 후보는 `builtinRoot` 의 각 하위 디렉토리 중 유효한 `manifest.json` 을 가진 것.
  - 타겟(`installRoot/<id>/`) 없음 → `cp -r` 로 seed.
  - 타겟 있음 + 번들 `version` 이 strictly newer → 디렉토리 삭제 후 재복사 (upgrade).
  - 타겟 있음 + 번들 `version` 이 ≤ 설치본 → skip (사용자 수정 보존).
  - 매니페스트 검증 실패는 throw 하지 않고 logger 로만 보고 — 부팅은 계속.
- **`BUILTIN_SKILLS_ROOT`**: `fileURLToPath(new URL('../builtin', import.meta.url))` — dev(tsx) / dist 두 경로 모두 동작.
- **내장 스킬 목록 (v0.5)**:
  - **`architecture-lookup`**: 본 문서(`visualize_architecture.md`) 를 번들로 포함. 두 툴 노출 —
    - `architecture.lookup({ section? })`: 미제공 시 TOC, `"6"` / `"E1"` / `"EGO"` 같은 키워드 매치 시 해당 섹션 본문 (MAX_OUTPUT_CHARS=8000 cap + `[truncated]` 마커).
    - `architecture.search({ query, maxResults? })`: 섹션별 case-insensitive 서브스트링 매칭 + 힛 수 정렬 + ±80자 snippet. query 는 정규식 이스케이프.
  - **`trace-lookup`** (v0.5 신규): `<stateDir>/trace/traces.db` 를 `{ readOnly: true }` 로 열어 에이전트가 자기 자신의 파이프라인 trace 를 조회. 세 툴 노출 —
    - `trace.list({ sessionId?, limit? })`: 최근 trace 요약 newest-first. `listRecentTraces` 쿼리 + `firstTextPreview(G3 enter)` / `firstEgoAction(E1 decision)` 서브쿼리를 [packages/observability/src/trace-query.ts](D:\ai\agent-platform\packages\observability\src\trace-query.ts) 에서 **복제**(install 위치가 `~/.agent/skills/<id>/` 라 workspace 패키지 import 불가 — 전용 `node:sqlite`).
    - `trace.show({ traceId, blockFilter?, maxEvents? })`: 단일 trace 의 블록별 타임라인. `blockFilter: ['E1','W1']` 로 블록 제한, `maxEvents` 절단 시 `…[truncated, N more events]` 꼬리.
    - `trace.last({ sessionId? })`: 가장 최근 trace 의 요약 1행 + 전체 타임라인 (`getLastTraceId` + `getTraceTimeline` 조합).
    - 매 호출마다 `open → try/finally close` 로 WAL writer 와 공존 (장기 reader 핸들 금지). DB 부재 → `success:true, output:"no trace DB at <path>. Tracing may be disabled (AGENT_TRACE=0) or no turn has run yet."` 친절 분기.
  - **프라이버시**: 양쪽 모두 `permissions: []`, `riskLevel: 'low'`. architecture-lookup 은 `installDir` 내부 단일 `.md` 파일만 읽고, trace-lookup 은 `<stateDir>/trace/traces.db` 를 read-only 로만 연다 (런타임 네트워크·셸 없음).

### 문서 재생성 플로우 (설계→구현 sync)
`visualize_architecture.md` 는 설계 리포(`D:\ai\claude`)가 authoritative. 구현 리포의 `packages/skills/builtin/architecture-lookup/visualize_architecture.md` 는 미러.
1. 설계 리포에서 §12 재생성 가이드대로 본문 갱신 + 헤더 버전 bump.
2. 구현 리포의 번들 파일을 덮어쓰기 (`cp`).
3. `packages/skills/builtin/architecture-lookup/manifest.json` 의 `version` bump + `contentSha256` 재계산 (`hashSkillDirectory` 와 동일 알고리즘, `manifest.json` 자신은 제외).
4. 상위 버전 감지 → [K2] 가 다음 gateway 기동 시 자동 upgrade.

---

## 10. 역방향 스트림 경로 (델타 → TUI)

델타 하나가 모델에서 TUI 화면까지 도달하는 경로:

```
ModelAdapter.stream()        [M1]   yields {type:'text_delta', text}
  → ReactExecutor            [R2]   yield {kind:'delta', text}
    → (HybridReasoner yield*) [R1]  pass-through
      → AgentRunner for-await [W1]  responseText+=ev.text; onChunk?.(ev.text)
        → onChunk = handlerCtx.emit
          → handlerCtx.emit = (text)=>ctx.notify('chat.delta',{requestId,text})
            → RpcServer.dispatch RpcContext.notify [G2]
              → ws.send(JSON-RPC notification frame)
                → TUI WebSocket onmessage
                  → RpcClient.handleMessage  [T3]
                    → pending(requestId).onNotification('chat.delta', {text})
                      → App.send() 의 onNotification 콜백  [T2]
                        → setTurns(prev → assistant.text += text)
                          → ChatHistory 재렌더  [T1→ChatHistory]
```

최종 응답 경로:

```
[R2/R3] yield {kind:'final'} & {kind:'usage'}
  → [W1] TurnResult 반환
    → [P1] { inputTokens, outputTokens, costUsd } 반환
      → [G3] emitPhase('finalizing') → emitPhase('complete')    ← ADR-010
      → [G3] result 객체 조립 + sessionId/traceId/messageId 포함
        → [G2] successFrame(id, result) → ws.send
          → [T3] pending.resolve(result)
            → [T2] .then(result) — streaming=false, usage 표시
              → [T1→StatusLine/ChatHistory] 최종 렌더
```

**Phase Event 경로 (ADR-010, v0.4 신규 스트림)**:

```
[P1] emitPhase('ego_judging')                  ← EGO 진입 직전
  [W1] onPhase('reasoning_route', mode)        ← reasoner.run 직전
    [W1] onPhase('streaming_response')         ← 첫 delta (1회)
    [W1] step→tool_call/planning/replan 매핑   ← 매 ReasoningStep
[G3] emitPhase('finalizing')  emitPhase('complete'|'aborted'|'error')
  → ctx.notify('chat.phase', { requestId, turnId, sessionId, seq, at,
                                phase, elapsedMs, detail? })
    → [T3] handleMessage — requestId 매칭으로 pending onNotification
      → [T2] setPhase(PhaseIndicator) — terminal/streaming_response 시 null
        → PhaseLine 이 InputBar 바로 아래에 [아이콘 라벨] elapsed 렌더
```

`chat.delta` (토큰) 와 `chat.phase` (진행 상황) 은 동일 소켓을 공유하는 독립 스트림으로, 순서 보존은 WebSocket 이 보장. `turnClosed` 가드가 terminal phase 이후 추가 emit 을 무음으로 차단.

---

## 11. 채널별 차이 요약 (참고)

모두 `[P1] handler` 에 수렴한다. 본 문서가 추적하는 것은 **TUI → /rpc** 경로이지만, 다른 채널도 동일한 handler 를 호출한다:

| 경로 | 트랜스포트 | emit 구현 | 주 엔트리 |
|------|-----------|-----------|----------|
| TUI | WebSocket `/rpc` (JSON-RPC 2.0) | `ctx.notify('chat.delta', …)` | `methods['chat.send']` |
| WebChat 브라우저 | WebSocket `/webchat` | `webchat.emitDelta(conversationId, traceId, text)` | `webchat.onMessage((msg)=>…)` in [P1] |
| ApiGateway `/ws` (envelope) | WebSocket envelope 프로토콜 | 엔벨로프 chunk 전송 | `ApiGateway` 내장 handler dispatch |
| Telegram/Slack/Discord/WhatsApp | 각 Bot API | 각 어댑터 `sendMessage` | 채널 어댑터 `onMessage` → `router` → `handler` |

즉 `handler` 는 모든 경로가 공유하는 **단일 pipeline entry** 이고, 델타 emit 함수의 구현만 채널마다 다르다.

---

## 12. 재생성 가이드 — 코드 업데이트 시 다이어그램 재작성 절차

> 이 섹션은 **본 문서가 문서화한 범위가 최신인지 검증**하고, 필요 시 §0 ASCII 다이어그램과 §2~§10 을 업데이트하기 위한 체크리스트다. 아래 파일들을 순서대로 확인해 변경이 있으면 해당 블록을 재기술한다.

### 12.1. 블록별 소스 오브 트루스 (필독 파일)

| 블록 | 파일 | 체크 포인트 |
|------|------|------------|
| [T1] InputBar | `packages/tui/src/components/InputBar.tsx` | `useInput` 키 핸들러, onSubmit 시그니처 |
| [T2] App | `packages/tui/src/App.tsx` | `send()` 함수 내 `client.call('chat.send', params, opts)` 의 params 필드, onNotification 가 처리하는 method 이름 집합 |
| [T3] RpcClient | `packages/tui/src/lib/rpc-client.ts` | `handleMessage()` 에서 notification 매칭 규칙(`params.requestId`), 재연결 정책 |
| [G1] ApiGateway | `packages/control-plane/src/gateway/server.ts` | `mount()` 가능 path, Bearer 토큰 추출, 레이트리밋 세팅 |
| [G2] RpcServer | `packages/gateway-cli/src/rpc/server.ts` | `RpcContext` 필드, `dispatch()` 분기 (`MethodNotFound` 등), `onShutdownRequested` 훅 |
| [G3] RpcMethods | `packages/gateway-cli/src/rpc/methods.ts` | `chat.send` 가 만드는 `StandardMessage` 필드, `chat.accepted` / `chat.delta` notification 네이밍, `handlerCtx.emit` 시그니처 |
| [C1] RuleRouter | `packages/control-plane/src/session/router.ts` | 매칭 규칙 우선순위, 기본 agentId |
| [C2] SessionStore | `packages/control-plane/src/session/store.ts` | `addEvent` 스키마 변경, `getRecentEvents` 페이지 크기 |
| [C2'] PlatformChannelRegistry | `packages/control-plane/src/gateway/platform-channel-registry.ts` | `ChannelDescriptor` 필드, register/recordEvent/recordError/deregister 의미, status 파생 규칙 |
| [C2''] SchedulerService | `packages/scheduler/src/scheduler.ts` + `runners/*` + `json-task-store.ts` + `types.ts` | `CronTask` union (3 타입), node-cron `schedule` 옵션, 동시성 정책 (skip vs throw), runner 의 sandbox/policy 경로, tasks.json JSON5 파서 |
| [P1] Platform handler | `packages/cli/src/runtime/platform.ts` | `startPlatform()` 의 배선, `handler` 내부의 withSpan 이름, `_egoPerception` / `_egoCognition` / `_egoGoalUpdates` / `_egoDecisionId` / `_egoEnrichment` metadata 키, scheduler start/stop 순서 |
| [E1] EgoLayer | `packages/ego/src/layer.ts` | `processDetailed()` 단계별 로직, ProcessRecord 필드, `materializeDecision()` action 분기 |
| [E1] LLM Factory | `packages/ego/src/llm-adapter-factory.ts` + `llm-adapter-openai.ts` + `llm-adapter.ts` + `llm-adapter-fallback.ts` + `llm-adapter-shared.ts` | `createEgoLlmAdapter(config)` 가 provider 분기 + env 프리플라이트 + fallback 합성. 새 provider 추가 시 이 팩토리만 확장. |
| [W1] AgentRunner | `packages/agent-worker/src/runner/agent-runner.ts` | `processTurn()` 의 단계, `ReasoningContext` 조립 필드, 이벤트 kind 집합 |
| [W2] PromptBuilder | `packages/agent-worker/src/prompt/builder.ts` | enrichment 삽입 위치, 메시지 순서 |
| [R1] HybridReasoner | `packages/agent-worker/src/reasoning/hybrid-reasoner.ts` | `toolsWired` 판정 조건, `selectMode` 로직 |
| [R1a] ComplexityRouter | `packages/agent-worker/src/reasoning/complexity-router.ts` | egoPerception 기반 선택 규칙, 휴리스틱 |
| [R2] ReactExecutor | `packages/agent-worker/src/reasoning/react-executor.ts` | 루프 budget, tool_call 파싱, observation 주입 |
| [R3] PlanExecuteExecutor | `packages/agent-worker/src/reasoning/plan-execute-executor.ts` | planner JSON 파싱 폴백, `computeLevels`, `parallelExecution`, replan 트리거 종류 (#1 retry / #3 goal-update — v0.7 추가), `TRIGGER_3_REL_THRESHOLD` 상수 |
| [M1] ModelAdapter | `packages/cli/src/runtime/model-adapter.ts`, `packages/agent-worker/src/model/` | stream chunk 타입, `getModelInfo()` 출력 |
| [S1] Sandbox/Guard | `packages/agent-worker/src/security/`, `packages/agent-worker/src/tools/` | `ownerPolicy` 정책, `InProcessSandbox.invoke()` 시그니처, bashTool Docker 옵션 |
| TraceLogger (§13) | `packages/core/src/contracts/trace-logger.ts` + `packages/observability/src/sqlite-trace-log.ts` + `packages/observability/src/trace-query.ts` + `packages/cli/src/commands/trace.ts` | `TraceLogger` / `TraceEvent` / `TraceBlock` 계약, 각 블록 emit 포인트, `agent trace` CLI 의 출력 포맷, retention / env toggle 규약 |

### 12.2. 설계 문서 쪽 소스 오브 트루스

| 블록 | 설계 문서 | 섹션 |
|------|----------|------|
| 전체 아키텍처 | `harness-engineering.md` | §2.1, §3.2A |
| EGO 파이프라인 | `ego-design.md` | §5 (S1~S7), §5.6 (confidence override), §5.7 (JSON validation + fallback) |
| EGO persona | `ego-persona.md` | §4 evolution |
| Reasoning | `agent-orchestration.md` | §1.2 (HybridReasoner), §2 (ReAct/Plan-Execute), §3 (replan) |
| `current_process.md` | 구현 현황 · 잔여 작업 | §4 페이즈, §7 트레이드오프 |

### 12.3. 변경 감지 루틴

코드가 업데이트되었을 때 본 문서 재작성이 필요한지 판정하는 체크리스트:

1. **RPC 메서드 집합이 바뀌었는가?**
   - `packages/gateway-cli/src/rpc/methods.ts` 의 `buildRpcMethods` 반환 객체 키 변화 → §3 [G3] 업데이트.
   - 새 notification 이름이 추가되었는가? (`chat.*`, `gateway.*`) → §10 역방향 경로 업데이트.

2. **handler 시그니처가 바뀌었는가?**
   - `MessageHandler` / `MessageHandlerContext` 필드 (`emit`, `sessionId`, `agentId`, `traceId`) → §3/§5 의 시그니처 박스 업데이트.

3. **EgoDecision 유니온이 바뀌었는가?**
   - `action` 문자열 추가·삭제 → §6 [E1] + §8.4 EgoDecision + §0 블록 다이어그램 분기 업데이트. CLAUDE.md invariants 도 확인.

4. **StandardMessage 에 새 metadata 규약이 생겼는가?**
   - `channel.metadata._ego*` 외 새 접두사 → §8.4 + §6 E1 materialize 단계 기록.

5. **ReasoningEvent kind 가 확장되었는가?**
   - `packages/core/src/contracts/` 의 `ReasoningEvent` 유니온 → §8.4 + §7 [W1] for-await 블록 업데이트.

6. **Reasoner 모드가 추가되었는가?**
   - `HybridReasoner.selectMode` 반환값에 새 모드 (`react`/`plan_execute` 외) → §8 [R1]/[R1a] + §0 블록 다이어그램의 분기 업데이트.

7. **ComplexityRouter 입력이 바뀌었는가?**
   - `ComplexityRouterInput` 필드 추가 (새 perception 필드 등) → §6 E1 perception 부착 로직 + §7 [W1] `ReasoningContext` 블록.

8. **Platform 배선이 바뀌었는가?**
   - `platform.ts` 에서 새 컴포넌트(예: 추가 guard, 추가 observability 호출) → §5 [P1] 단계 열거 업데이트 + §0 에 블록 추가.

9. **채널이 추가되었는가?**
   - 새 채널 어댑터 — `[P1]` 은 그대로여도 §11 표에 행 추가.

10. **설계 문서 버전이 올랐는가?**
    - `harness-engineering.md` / `ego-design.md` / `agent-orchestration.md` 의 상단 버전 블록 diff 확인 → 본 문서 머리말의 "상위 문서" 줄 업데이트 + 버전 bump.

11. **EGO LLM provider 가 추가·변경되었는가?**
    - `EgoLlmConfig.provider` 유니온 (`packages/core/src/types/ego.ts`), `createEgoLlmAdapter` 의 `switch(provider)` 분기, `defaultActiveEgoConfig` 의 기본 provider → §6 [E1] 설명 업데이트.

12. **TraceLogger 블록/이벤트 목록이 변했는가?**
    - 새 `TraceBlock` 추가 (`packages/core/src/contracts/trace-logger.ts`) 또는 기존 블록의 이벤트 이름 변경 → §13 TraceLogger 섹션의 "블록별 이벤트 매트릭스" 업데이트. 새 CLI 서브명령은 §13 의 "CLI 표면" 업데이트.

### 12.4. 재작성 작업 순서 (권장)

1. `current_process.md` §4 페이즈 표를 먼저 읽어 최근 어느 영역이 바뀌었는지 파악.
2. §12.3 체크리스트를 따라 8~10개 포인트를 점검.
3. 영향 받는 **블록만** §2~§9 에서 재기술 (영향 없는 블록은 그대로 유지).
4. §0 ASCII 다이어그램을 재생성 — 박스 순서 · 화살표 · 라벨 일치 확인.
5. §10 역방향 스트림 경로의 함수 체인을 실제 소스로 한 번 재확인.
6. 문서 상단 `문서 버전` 을 bump (feature add = minor, breaking = major).
7. 동일 저장소의 다른 문서들과 `EgoDecision` action 네이밍 · `channel.metadata` 키 · Palace wing 이름 등 **CLAUDE.md 의 invariant 리스트**가 깨지지 않았는지 grep 검증.

### 12.5. 재작성 시 유용한 grep 패턴

```bash
# chat.send RPC 가 만드는 메시지 스키마
grep -n "StandardMessage" packages/gateway-cli/src/rpc/methods.ts

# EGO 가 붙이는 metadata 키
grep -rn "_ego" packages/ego packages/cli packages/agent-worker

# ReasoningEvent kind 집합
grep -rn "kind:" packages/agent-worker/src/reasoning

# handler 시그니처가 쓰이는 곳
grep -rn "MessageHandler" packages/control-plane packages/cli

# 스트리밍 emit 체인
grep -rn "ctx.notify" packages/gateway-cli
grep -rn "emitDelta"  packages/channels
grep -rn "onChunk"    packages/agent-worker

# EGO LLM provider 분기 + 기본값
grep -n "'anthropic'\|'openai'" packages/ego/src/llm-adapter-factory.ts
grep -n "defaultActiveEgoConfig\|provider:" packages/cli/src/commands/gateway.ts

# TraceLogger emit 포인트 (각 블록이 traceLogger 를 어떻게 쓰는지)
grep -rn "traceLogger\?\.event\|traceLogger\?\.span" packages
grep -rn "block: '[GCEPWRM][0-9]" packages
```

---

## 13. TraceLogger — 파이프라인 횡단 관찰성 레이어

v0.2 에서 추가된 구조적 트레이스 시스템. 각 블록이 무엇을 했는지 turn 단위로 SQLite 에 기록하고, CLI (`agent trace …`) 로 조회할 수 있게 한다. OTel `withSpan` 은 그대로 공존 — trace DB 는 오프라인 사후 분석용, OTel 은 라이브 observability 용.

### 13.1. 계약

- **파일**: [packages/core/src/contracts/trace-logger.ts](D:\ai\agent-platform\packages\core\src\contracts\trace-logger.ts)
- **핵심 인터페이스**:
  ```ts
  interface TraceLogger {
    event(entry: TraceEvent): void;          // fire-and-forget
    span<T>(opts, fn): Promise<T>;           // enter/exit 자동 emit + 예외 시 error 이벤트
    close?(): Promise<void>;
  }
  type TraceBlock = 'G3'|'C1'|'P1'|'E1'|'W1'|'R1'|'R2'|'R3'|'M1';
  interface TraceEvent {
    traceId: string; sessionId?: string; agentId?: string;
    block: TraceBlock;
    event: string;         // 자유 문자열. 블록별 관례는 §13.3 표 참고.
    timestamp: number;     // epoch ms
    durationMs?: number;   // exit 이벤트에서만 세팅
    payload?: Record<string, unknown>;
    error?: string;
  }
  ```
- **불변량**: `event()` / `span()` 은 절대 throw 하지 않는다. 쓰기 실패(DB 잠김 등)는 조용히 무시 — 계측이 파이프라인을 깨선 안 된다.
- **기본 구현**: [`SqliteTraceLog`](D:\ai\agent-platform\packages\observability\src\sqlite-trace-log.ts) (SQLite WAL, `node:sqlite` 내장). Opt-out 은 [`NoopTraceLogger`](D:\ai\agent-platform\packages\core\src\contracts\trace-logger.ts).

### 13.2. 배선 체인

```
  AGENT_TRACE != '0'  →  startPlatform() 이 SqliteTraceLog 인스턴스화
                          ↓ (traceLogger 단일 인스턴스 DI)
  ┌───────────────────────┬───────────────────────┐
  │ RuleRouter (C1)       │ RpcDeps.traceLogger    │
  │   routerOptions       │   (G3 직접 emit)       │
  ├───────────────────────┼───────────────────────┤
  │ EgoLayerDeps          │ AgentRunnerDeps        │
  │   (E1)                │   (W1)                 │
  ├───────────────────────┼───────────────────────┤
  │ MessageHandlerContext │ ReactExecutorDeps      │
  │   (P1 handler 내부)   │   (R1/R2 via ctx       │
  │                       │    traceLogger field)  │
  ├───────────────────────┴───────────────────────┤
  │ ReasoningContext.traceLogger  (W1 이 매 턴 주입) │
  │   ↓                                            │
  │ HybridReasoner (R1), ReactExecutor (R2),       │
  │ PlanExecuteExecutor (R3) 가 ctx.traceLogger 로 │
  │ 내부 이벤트 emit                               │
  └────────────────────────────────────────────────┘
```

단일 `traceLogger` 인스턴스가 모든 블록에 공유되고, 각 emit 은 `msg.traceId` / `ctx.traceId` / `ctx.userMessage.traceId` 로 동일 traceId 를 실어 보낸다.

### 13.3. 블록별 이벤트 매트릭스 (Phase A)

| 블록 | 파일 | 이벤트 | 주요 payload |
|------|------|--------|-------------|
| **G3** | `packages/gateway-cli/src/rpc/methods.ts` | `enter` / `exit` / `error` | textPreview(80자), conversationId, channelId, senderId / usage |
| **C1** | `packages/control-plane/src/session/router.ts` | `decision` | matchedRuleId, priority |
| **P1** | `packages/cli/src/runtime/platform.ts` | `enter` / `exit` / `error` / `skill_mount_error` | egoAction (exit) / skillId, error (skill_mount) |
| **E1** | `packages/ego/src/layer.ts` | `fast_exit` / `deep_path_start` / `decision` / `error` | intent, complexity, urgency / action, confidence, costUsd, egoDecisionId / `error` v0.5: `tag` (ego_timeout\|ego_runtime_error\|llm_*) + `validationErrors[{path,message}]` (5건 cap, SchemaValidationError 전용) + `candidatePreview` (800자 cap) |
| **W1** | `packages/agent-worker/src/runner/agent-runner.ts` | `session_resolved` / `history_loaded` / `prompt_built` / `reasoner_invoked` / `stream_done` / `session_events_appended` / `session_append_failed` / `memory_ingested` | isNew, status / eventCount / priorMessageCount, hasEnrichment / availableTools / responseLen, inputTokens, outputTokens, costUsd / appendedCount / error / ingested |
| **R1** | `packages/agent-worker/src/reasoning/hybrid-reasoner.ts` | `mode_selected` | mode, routerSuggested, planExecuteAvailable |
| **R2** | `packages/agent-worker/src/reasoning/react-executor.ts` | `tool_call` | toolName, toolStatus(`ok\|denied\|error`), retry |
| **R3** | `packages/agent-worker/src/reasoning/plan-execute-executor.ts` | `plan_generated` / `replan` / `downgraded_to_react` | stepCount / round, failedStepId / replanCount, reason |
| **M1** | (Phase B 예정) | — | — |

**이벤트 이름 canonical 화** (ADR-010): `packages/core/src/contracts/trace-logger.ts` 의 `TraceEventNames` 상수에 W1 관측 이벤트 어휘가 export 되어 있다 (`SESSION_RESOLVED`, `HISTORY_LOADED`, `MEMORY_SEARCHED`, `PROMPT_BUILT`, `REASONER_INVOKED`, `REASONING_STEP`, `REASONING_PLAN`, `REASONING_REPLAN`, `STREAM_DONE`, `SESSION_EVENTS_APPENDED`, `SESSION_APPEND_FAILED`, `MEMORY_INGESTED`). 구현체는 이 문자열을 그대로 `event` 필드에 넣어 다운스트림 로그 해석기의 키 역할을 수행한다.

### 13.4. 저장 스키마 (`~/.agent/trace/traces.db`)

```sql
CREATE TABLE trace_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id     TEXT NOT NULL,
  session_id   TEXT,
  agent_id     TEXT,
  block        TEXT NOT NULL,
  event        TEXT NOT NULL,
  timestamp    INTEGER NOT NULL,
  duration_ms  INTEGER,
  payload      TEXT,           -- JSON blob
  error        TEXT
);
CREATE INDEX idx_trace_events_trace  ON trace_events(trace_id, timestamp);
CREATE INDEX idx_trace_events_session ON trace_events(session_id, timestamp);
CREATE INDEX idx_trace_events_block  ON trace_events(block, timestamp);
```

- 경로는 [`resolveGatewayPaths().traceDb`](D:\ai\agent-platform\packages\gateway-cli\src\lifecycle\paths.ts) 가 계산. 기본 `~/.agent/trace/traces.db` (AGENT_STATE_DIR override 존중).
- WAL 모드. 기동 시 `retentionDays` (기본 14, env `AGENT_TRACE_RETENTION_DAYS`) 이전 row 자동 삭제.
- `sessions.db` / `ego/audit.db` 와 **완전 분리** — 생명주기가 다르므로 독립 보존·폐기 가능.

### 13.5. CLI 표면 (`agent trace …`)

- **파일**: [packages/cli/src/commands/trace.ts](D:\ai\agent-platform\packages\cli\src\commands\trace.ts) + [program.ts](D:\ai\agent-platform\packages\cli\src\program.ts).
- **특징**: gateway 프로세스를 거치지 않고 SQLite 파일 직접 open (`openTraceDb`). gateway 가 내려가 있어도 과거 트레이스 조회 가능.

| 서브명령 | 인자 / 옵션 | 동작 |
|---------|-----------|------|
| `agent trace list` | `-s --session`, `-n --limit` (기본 20) | 최근 트레이스 요약 (traceId, 세션, totalMs, egoAction, textPreview) |
| `agent trace show <traceId>` | `--format text\|json` | 블록별 타임라인 렌더 (offset, block, event, duration, payload 요약) |
| `agent trace last` | `-s --session`, `--format …` | 가장 최근 traceId 찾아 `show` 위임 |
| `agent trace export <traceId>` | `--format json\|ndjson` | 기계-읽기용 덤프 (공유·AI 도구 입력) |

### 13.6. 환경변수 토글

| 변수 | 기본값 | 의미 |
|------|-------|------|
| `AGENT_TRACE` | (unset, ON 취급) | `'0'` 이면 NoopTraceLogger 주입 — DB 쓰기 없음 |
| `AGENT_TRACE_RETENTION_DAYS` | `14` | 기동 시 cutoff 이전 row 삭제 기준 |
| `AGENT_STATE_DIR` | `~/.agent` | `traceDb` 파일 루트 override |

### 13.7. 설계 불변량 & 비목표

- 기존 `withSpan` (OTel span) 시그니처 / 네이밍 불변. `TraceLogger.span` 은 별개 채널로 공존.
- `SqliteAuditLog` 의 `ego_audit` 테이블 건드리지 않음 — 감사는 EGO 의 S7 책임, 트레이스는 turn-debug 책임.
- v0.3 범위 밖 (Phase B): 라이브 `agent trace tail`, M1 ModelAdapter 계측, sub-step verbose, trace diff.

---

## 14. Webapp 서피스 (브라우저 대시보드) — TUI 경로 대비 델타

Webapp 은 TUI 와 동일한 `/rpc` 엔드포인트·동일 RPC 메서드 세트·동일 `chat.phase` 스트림을 소비한다. 본 섹션은 **TUI 경로 대비 달라지는 지점** 만 블록 단위로 기술한다. [G1] 이후는 TUI 와 공유되므로 §3~§10 를 그대로 참조.

### 14.1 서피스 대응 표 (TUI [T*] ↔ Webapp [B*])

| TUI 블록 | Webapp 블록 | 파일 |
|---------|------------|------|
| [T1] InputBar | [B1] `<chat-input>` | packages/webapp/src/ui/chat/chat-input.ts |
| [T2] App.send | [B2] ChatController.send | packages/webapp/src/ui/controllers/chat-controller.ts |
| [T3] RpcClient | [B3] BrowserRpcClient | packages/webapp/src/ui/controllers/rpc-client.ts |
| `<PhaseLine>` (Ink) | `<phase-line>` (Lit) | packages/webapp/src/ui/components/phase-line.ts |
| (해당 없음) | [D1] DeviceIdentity | packages/webapp/src/ui/controllers/device-identity.ts |
| (해당 없음) | [V*] view-overview/channels/instances/sessions/cron | packages/webapp/src/ui/views/ |

### 14.2 블록 상세

```
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ [B1] chat-input (Lit CustomElement)                                          │
 │      in : DOM input event, Enter (w/o Shift)                                 │
 │      do : trim 후 dispatch `chat-send` CustomEvent(detail: string)           │
 │      out: bubbling CustomEvent                                               │
 └────────────────────────────────┬─────────────────────────────────────────────┘
                                  │
                                  ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ [B2] ChatController.send()                                                   │
 │      in : text                                                               │
 │      do : userId/agentId 발급, immutable update 로 turns 배열에 user +       │
 │           placeholder assistant turn push (Lit 의 === 비교 때문에 spread 필수)│
 │           params = { text, conversationId, sessionId? }                      │
 │      out: gateway.call('chat.send', params, { timeoutMs: 5m })               │
 └────────────────────────────────┬─────────────────────────────────────────────┘
                                  │
                                  ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ [B3] BrowserRpcClient.call()                                                 │
 │      in : method, params, options                                            │
 │      do : [D1] DeviceIdentity.assert() 로 세션 토큰 확보                      │
 │           new WebSocket(wsUrl, [`bearer.${token}`])  — 서브프로토콜로 인증    │
 │           JSON-RPC 2.0 request 프레임 전송                                    │
 │      out: Promise<R> — 서버 success/error frame 수신 시 resolve/reject        │
 └────────────────────────────────┬─────────────────────────────────────────────┘
                                  │ JSON-RPC over WS (subprotocol auth)
                                  ▼
                             (합류 지점: [G1] 부터 TUI 와 동일 경로)
```

### 14.3 [D1] DeviceIdentity — 브라우저 전용 인증 플로우

TUI 는 프로세스 환경변수/CLI 인자로 마스터 Bearer 를 확보하지만, 브라우저는 XSS 노출 최소화를 위해 device-identity 를 사용.

```
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ [D1a] 최초 실행 (IndexedDB 에 키 없음)                                         │
 │      in : 사용자가 `<enroll-dialog>` 에 마스터 Bearer 입력                     │
 │      do : @noble/ed25519 로 keypair 생성                                      │
 │           개인키 → IndexedDB (agent-platform/keys/devicePrivKey)              │
 │           공개키 → localStorage (ap:devicePubKeyHex)                          │
 │           fetch('/device/enroll', headers: Bearer <master>,                   │
 │                 body: {publicKeyHex, name})                                   │
 │      out: {deviceId} → localStorage(ap:deviceId)                              │
 └──────────────────────────────────────────────────────────────────────────────┘

 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ [D1b] 매 연결 전 DeviceIdentity.assert()                                      │
 │      in : (캐시된 세션 토큰 만료 시)                                           │
 │      do : POST /device/challenge {deviceId} → nonce (hex)                     │
 │           ed.signAsync(nonce_bytes, privKey) → signatureHex                   │
 │           POST /device/assert {deviceId, challenge, signature}                │
 │      out: {token, expiresAt} → 메모리 캐시 (TTL 1h 기본, 30s margin)          │
 └──────────────────────────────────────────────────────────────────────────────┘
```

**저장 분리 이유**: 개인키는 JS 에서 export 불가능한 저장소가 이상적이나 IndexedDB 가 현실적인 차선 — `localStorage` 와 달리 Storage 이벤트로 스크립트가 쉽게 감시할 수 없음. 공개키/deviceId 는 유출되어도 서명 없이는 무용.

### 14.4 [G4] `/device/*` 라우트 — control-plane/gateway/server.ts

| 경로 | 메서드 | 인증 | 처리 |
|------|--------|------|------|
| `/device/enroll` | POST | 마스터 Bearer 필요 | `DeviceAuthStore.enroll(publicKeyHex, name)` — 동일 pubkey 재등록은 deviceId 유지 (idempotent) |
| `/device/challenge` | POST | 미인증 | `DeviceAuthStore.issueChallenge(deviceId?)` — 32B 랜덤, 2분 TTL, 선택적 deviceId 피닝 |
| `/device/assert` | POST | 미인증 | `consumeChallenge` + `verifyEd25519` (node:crypto SPKI DER 래핑) → `issueSessionToken` — HMAC-SHA256 `v1.<deviceIdB64>.<expiryB64>.<rand>.<mac>` |
| `/ui` `/ui/*` | GET | 미인증 | `webapp.dir` 에서 파일 직접 서빙. 없으면 `index.html` fallback (SPA). 확장자 allow-list(html/js/css/svg/png/woff2/...) |

### 14.5 [G5] ApiGateway WS 업그레이드 — 인증 경로 2중 시도

```
handleUpgrade(req, socket, head):
  ┌─ Authorization 헤더 있음? (TUI 경로)
  │     → TokenAuth.verifyBearer → ok → upgrade
  │
  └─ 없거나 실패? Sec-WebSocket-Protocol 에서 "bearer.<token>" 찾기 (Webapp 경로)
        → TokenAuth.verifyToken(token) → ok → upgrade
        → 실패 시 HTTP/1.1 401 Unauthorized 반환 후 destroy
```

`TokenAuth` 는 마스터 토큰(timingSafeEqual) 매칭 실패 시 `SecondaryVerifier` (DeviceAuthStore) 에 위임 — TUI 와 Webapp 모두 동일 함수 통과.

### 14.6 Webapp Control 섹션 뷰 — Polling 모델

Chat 은 event-driven (RPC + notification) 이지만 Control 섹션(Overview/Channels/Instances/Sessions/Cron) 은 **5초 주기 폴링** 으로 공급된다.

```
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ [B4] PollingController (5s interval, visibilitychange 시 pause)              │
 │      do : Promise.all([overview.status, channels.list, instances.list,        │
 │                         cron.list, sessions.list]) 5개 RPC 병렬 호출           │
 │      out: 스냅샷 필드 갱신 → host.requestUpdate() → 각 view-* 가 구독 렌더     │
 └──────────────────────────────────────────────────────────────────────────────┘
```

**주의** (v0.7 갱신): `channels.list` / `cron.list` 는 `RpcDeps.channels?` / `RpcDeps.cron?` 레지스트리 주입 여부에 따라 실데이터 또는 빈 배열 반환. **현 플랫폼 와이어링은 두 레지스트리 모두 주입 상태** — `PlatformChannelRegistry` 는 WebChat 어댑터(현재 platform 에서 부팅하는 유일 채널)를 자동 등록하고, `SchedulerService` 는 `<stateDir>/scheduler/tasks.json` 에 정의된 태스크를 로드. Webapp Control 뷰가 실제 기동 상태를 폴링으로 소비한다. Telegram/Slack/Discord/WhatsApp 어댑터가 platform 기동 로직에 합류하면 동일 패턴으로 `channels.list` 에 노출된다. 참고: §4 `[C2']` / `[C2'']`.

---

## 15. Phase-Format 공유 (`@agent-platform/core/phase-format`)

TUI `<PhaseLine>` (Ink `<Text>`) 과 Webapp `<phase-line>` (Lit template) 은 서로 다른 렌더러지만 **완전히 동일한 문자열** 을 표시해야 한다 — "어떤 서피스에서 보든 같은 진실" 원칙(harness §3.2B). 이를 강제하는 구조:

```
packages/core/src/schema/phase-format.ts  ── 단일 소스 오브 트루스
  ├─ PhaseIndicator { phase, elapsedMs, toolName?, stepIndex?, totalSteps?, attemptNumber? }
  ├─ formatPhase(p: PhaseIndicator): string    — 순수 함수, Ink/DOM 의존성 없음
  ├─ PHASE_LABELS: Record<Phase, string>        — 'ego', 'tool', 'step', ...
  └─ PHASE_ICONS : Record<Phase, string>        — '◉', '🔧', '▶', ...

서브패스 export: @agent-platform/core/phase-format
  └─ 이유: core 메인 엔트리는 node:crypto 를 transitively import 하므로 브라우저 번들러가
          실패. phase-format 만 분리 노출해서 webapp 이 node-only deps 을 끌어오지 않도록.

소비자:
  packages/tui/src/components/StatusLine.tsx
    → `export { formatPhase } from '@agent-platform/core'` (재export, 하위호환)
  packages/tui/src/components/PhaseLine.tsx
    → `import { formatPhase } from '@agent-platform/core'`
  packages/webapp/src/ui/components/phase-line.ts
    → `import { formatPhase } from '@agent-platform/core/phase-format'`
```

### 15.1 Invariant

- **출력 포맷 문자열 동일**: `[🔧 bash_run] 3.2s`, `[▶ 2/5 file_read] 5.1s`, `[↻ replan #2] 8.4s` 등. TUI/Webapp 에서 byte-wise 동일해야 함.
- **PhaseIndicator shape 변경 시**: core 에 먼저 반영 → TUI `PhaseLine.tsx` 갱신 → Webapp `phase-line.ts` 갱신 (한 PR 로 묶을 것).
- **PHASE_LABELS / PHASE_ICONS Map 키 집합**: `Phase` 유니온 과 정확히 일치 (exhaustive). 새 Phase 추가 시 `phase.ts` 먼저 → `phase-format.ts` Map 둘 다 채움 → 미채움 시 TS 컴파일 실패.

### 15.2 유닛 테스트 단일화

`packages/tui/src/components/StatusLine.test.ts` 가 `formatPhase` 6 케이스 커버. core 로 이동 후에도 TUI 의 재export 경로로 동일 테스트가 회귀 검증. Webapp 쪽 별도 테스트는 미추가 (동일 함수를 import 하므로 회귀 위험 최소).

---

## 16. 변경 이력

- **v0.1.0 (2026-04-18)** — 초판. 설계 문서 v0.5.0 + 구현 v0.5.0 (516/517 테스트 통과) 기준. TUI → /rpc → Platform handler → EGO → AgentRunner → HybridReasoner → ReAct/Plan-Execute 전 구간 블록화. §12 재생성 가이드 포함.
- **v0.2.0 (2026-04-18)** — E1 배선 업데이트: `createEgoLlmAdapter` 팩토리 + OpenAI/Anthropic 멀티 provider + `FallbackEgoLlmAdapter` 데코레이터 + `defaultActiveEgoConfig` 기본값 OpenAI 로 전환. §13 TraceLogger 신규 섹션 (pipeline-wide 이벤트 로깅 + `agent trace` CLI). §12.1 / §12.3 / §12.5 재생성 가이드에 provider / trace 체크 항목 추가. 구현 테스트 538/539 → 556/557 (신규 +18건, OTLP optional peer 실패 1건 불변).
- **v0.3.0 (2026-04-18)** — 설계 문서 v0.6.0 (ADR-010) + 구현 U10 Phase 1-5 + tool name sanitize + reasoning-model 지원 + `fs.list` + `~/.agent/system-prompt.md` 로더 반영:
  - **ADR-010 세션 이력 persistence**: [C2] SessionStore 가 `appendEvent` / `loadHistory` 공개 계약. `session_events.event_type` 에 `reasoning_step` 공식 포함 (loadHistory 기본 includeKinds 에서 제외 — 프롬프트 오염 방지). [W1] AgentRunner 가 `loadHistory` 경유 + 턴 종결 시 user/assistant append 의 원자성 (실패 시 `session_append_failed` + throw) + Reasoner `{kind:'step'}` 이벤트 수신 시 reasoning_step best-effort append. [W2] PromptBuilder 의 conversationHistory 매핑 규약 (compaction → systemPrompt 1건 합류, reasoning_step 방어적 드롭).
  - **EGO fastPath 게이트**: `ego.json` 의 `fastPath.enabled: false` 또는 `EGO_FORCE_DEEP=1` env 로 모든 턴을 deep path 로 강제. `ego-design.md` 의 enrichment schema 에 `suggestTools` 가 PromptBuilder 힌트로 전파됨을 명시.
  - **Tool name sanitize**: OpenAI/Anthropic 이 `^[a-zA-Z0-9_-]+$` 패턴만 허용해서 canonical `fs.read` 등이 400 에러를 냈던 버그 수정. [M1] ModelAdapter 의 `buildToolNameMap(tools)` 가 양방향 매핑 (canonical ↔ wire) 을 보유하고 `tool_call_start` 에서 다시 canonical 로 복원. assistant `toolCalls:[…]` 직렬화도 추가 (이전에는 tool_calls 없는 assistant 메시지 다음의 `role:'tool'` 이 거부당하던 문제).
  - **Reasoning-model 지원**: `gpt-5.x` / `o1-o4` 를 [M1] OpenAIAdapter + EGO OpenAiEgoLlmAdapter 모두 감지해 `max_completion_tokens` 사용 + `temperature` / `top_p` 제외.
  - **[K1] LiveToolRegistry + skill authoring (U10 Phase 3-5)** 신규 블록. `skill.create/list/remove/reload` 4 tool, `LocalSkillRegistry.installFromDefinition`, `assertSafeEntryPoint` traversal 가드, `staticCheckSource` 정적 검사 (eval/child_process/require/dynamic import 거부). owner-trust 는 PolicyCapabilityGuard 의 filesystem.write 정책으로 자동 강제.
  - **기본 도구**: `fs.list` 추가 (디렉토리 나열 — fs.read roots 공유). platform 이 `defaultToolsConfig` 로 zero-config 기본 도구 세트 주입.
  - **Agent system prompt**: gateway 가 `<stateDir>/system-prompt.md` 를 기동 시 로드해 `AgentConfig.systemPrompt` 로 주입 (EGO 의 `<stateDir>/ego/system-prompt.md` 와 독립).
  - 구현 테스트 556/557 → 608/609 (신규 +52건).
- **v0.4.0 (2026-04-19)** — 설계 문서 harness v0.6.0 (ADR-010 TUI Phase Event Stream 엔드투엔드) + TUI flicker-free 렌더 + first-party 내장 스킬 부트스트랩:
  - **[G3] `chat.phase` JSON-RPC notification 추가**: `received` → `ego_judging` → `reasoning_route` → `planning` / `tool_call` / `replan` → `streaming_response` → `finalizing` → `complete` / `aborted` / `error` 13값 Phase 어휘로 턴 라이프사이클 전 구간 발행. `turnId`=`traceId`, `seq` 단조 증가, terminal phase 이후 재진입 가드, `classifyError` 로 에러 원문 대신 opaque code 만 전파.
  - **[P1] Platform handler**: EGO 진입 직전 `ego_judging` emit, `runner.processTurn` 에 `ctx.emitPhase` 4번째 인자로 전달.
  - **[W1] AgentRunner**: `onPhase?(phase, detail?)` 콜백 추가. `reasoning_route`(reasoningMode), 첫 delta 1회에 `streaming_response`, ReasoningStep kind(`tool_call`/`plan`/`replan`) → Phase 매핑. `readToolName` 으로 도구 인자 누출 차단. 미구현 항목: `waiting_tool` (react-executor 가 샌드박스 경계 이벤트 미노출), `executing_step.stepIndex/totalSteps` (plan-execute 단계 경계 이벤트 미노출).
  - **[T2] TUI flicker 수정**: 완료 turn 을 Ink `<Static>` 으로 스크롤백에 1회 commit — 스트리밍 delta 마다 과거 출력 repaint 제거. streaming turn + empty-state 는 `StatusLine` 과 같은 flex column 안에서 StatusLine **바로 위**에 명시 배치 → 모든 응답이 "connected ws://…" 라인 위쪽에만 출력. `PhaseLine` 신규 컴포넌트를 `InputBar` **아래**에 배치(ETA 없음, phase-only).
  - **[K2] seedBuiltinSkills + architecture-lookup (U11)** 신규 §9 하위 블록. `packages/skills/builtin/*` 를 gateway 기동 시 `~/.agent/skills/*/` 로 idempotent 시드(버전 비교 기반 upgrade, 사용자 수정 보존). `BUILTIN_SKILLS_ROOT` 상수 + `seedBuiltinSkills(installRoot, builtinRoot)` API. 첫 내장 스킬 `architecture-lookup` 이 본 문서 자체를 번들로 포함하고 `architecture.lookup` + `architecture.search` 두 툴로 섹션·검색 조회 노출. 설계↔구현 sync 플로우 §9 말미에 문서화.
  - **§10 역방향 스트림 경로** 확장: Phase Event 경로 도식 신규 추가 ([P1]/[W1]/[G3] → `chat.phase` notification → [T3]/[T2] PhaseLine).
- **v0.5.0 (2026-04-19)** — E1 에러 진단·분류 정정 + skill 로더 하위호환 + 두 번째 내장 스킬 `trace-lookup`:
  - **[E1] 에러 태그 정정** ([packages/ego/src/layer.ts](D:\ai\agent-platform\packages\ego\src\layer.ts), [packages/core/src/errors.ts](D:\ai\agent-platform\packages\core\src\errors.ts)): `SchemaValidationError.tag` 가 이전에는 항상 하드코딩 `llm_schema_mismatch` 였던 버그 수정 — options bag 으로 `tag` · `candidate` 받도록 확장, `parseOrThrow` / belt-and-suspenders 검증 양쪽에서 `classifyValidationFailure` 실제 결과 전달. 호환성: 기존 caller 는 그대로 `llm_schema_mismatch` 기본값 유지.
  - **[E1] E1 `error` trace payload 강화**: 이전엔 `error` 문자열만 있어 원인 지목 불가. v0.5 부터는 `payload: { tag, validationErrors[{path,message}] (5건 cap), candidatePreview (800자 cap) }` 추가. `buildErrorPayload(err, tag)` 가 `SchemaValidationError` 외의 에러(timeout/runtime)도 tag 만이라도 채움.
  - **[E1] LLM 프롬프트 그라운딩**: `buildUserPrompt` 가 `Schemas.EgoThinkingSchema.EgoThinkingResult` JSON Schema 전문 + action-contingent 필수 필드 규칙 주입. `response_format: json_object` 는 문법만 강제하므로 schema 준수는 프롬프트가 담당. 유사 회귀(`llm_inconsistent_action` / `llm_schema_mismatch`) 발생 빈도 감소 목적.
  - **[core/time.ts] `TimeoutError` 도입**: `withTimeout` 이 이전에는 plain `Error` 를 throw 하고 [E1] catch 는 `err instanceof EgoTimeoutError` (never-thrown dead class) 로만 timeout 체크 → 모든 pipeline 타임아웃이 `ego_runtime_error` 로 silent 오분류되던 day-1 버그 수정. `TimeoutError extends Error` 신규(`label`, `timeoutMs`, `name='TimeoutError'`) — [E1] 은 `TimeoutError` / `EgoTimeoutError` 둘 다 인식. 재노출: `packages/core/src/index.ts`.
  - **[K1] Skill loader `call` alias**: agent-authored skill 이 `execute(args, ctx)` 대신 레거시 `call(args, ctx)` 를 썼을 때 `loaded.execute is not a function` 으로 실패하던 회귀 수정. `loadSkillTools` 가 `normalizeToolHandler` 로 handler 이름 정규화 — 다른 필드(`description` / `permissions` / `riskLevel` / `inputSchema` / `runsInContainer` / `dockerCommand`)는 그대로 보존. 둘 다 없으면 명확한 에러. `skill.create` 의 `sourceCode` description 에 "`execute(args, ctx)` required" 명시.
  - **[K2] `trace-lookup` 내장 스킬 신규**: 에이전트가 자기 자신의 파이프라인 trace 를 조회하도록 `trace.list` / `trace.show` / `trace.last` 3 툴 노출. `<stateDir>/trace/traces.db` 를 `{ readOnly: true }` 로 open, 매 호출 open/close (WAL writer 와 공존). `packages/observability/src/trace-query.ts` 의 3 가지 SQL 을 install 환경 제약(`~/.agent/skills/<id>/` — workspace 패키지 import 불가) 때문에 복제. self-contained(`node:sqlite` 만 사용), `permissions: []`, `riskLevel: 'low'`.
  - **문서**: §1 헤더 v0.5 요약, §6 E1 deep path 검증·에러 처리 블록, §9 [K1] Handler 정규화 / [K2] 내장 스킬 목록 확장, §13.3 이벤트 매트릭스 E1 error payload 필드 추가, §14 본 엔트리.
- **v0.6.0 (2026-04-21)** — ADR-010 브라우저 대시보드 + device-identity 인증 엔드투엔드 반영:
  - **신규 §14 "Webapp 서피스"**: packages/webapp (Vite + Lit 3) 블록 다이어그램. [B1] `<chat-input>` → [B2] ChatController.send → [B3] BrowserRpcClient → [G1] 합류. [D1] DeviceIdentity 의 enroll/assert 2단계 플로우 (@noble/ed25519 + IndexedDB). [G4] `/device/{enroll,challenge,assert}` 라우트 + `/ui/*` 정적 서빙. [G5] ApiGateway WS 업그레이드가 Authorization 헤더와 `Sec-WebSocket-Protocol: bearer.<token>` 서브프로토콜을 이중 시도. Control 섹션 뷰 폴링 모델([B4] PollingController, 5s + visibilitychange pause).
  - **신규 §15 "Phase-Format 공유"**: `formatPhase`/`PhaseIndicator`/`PHASE_LABELS`/`PHASE_ICONS` 를 `packages/tui/src/components/StatusLine.tsx` → `packages/core/src/schema/phase-format.ts` 로 이전. 서브패스 export `@agent-platform/core/phase-format` 신설(webapp 이 node-only deps 을 transitively 끌어오지 않도록). TUI StatusLine 은 하위호환 재export 유지. Invariant: 출력 포맷 바이트 동일, PhaseIndicator shape 변경 시 core → TUI → Webapp 한 PR 로 업데이트.
  - **§0 한눈에 보기**: TUI 위에 Webapp 블록 병렬 배치. 두 서피스가 [G1] 에서 합류함을 도식화.
  - **[G1] ApiGateway**: `TokenAuth.verifyBearer` 가 마스터 토큰 timingSafeEqual 실패 시 `SecondaryVerifier` (DeviceAuthStore) 에 fallback — TUI 와 Webapp 모두 동일 함수 통과.
  - **[G3] RpcMethods 확장**: `overview.status`, `channels.list`, `channels.status`, `instances.list`, `cron.list`, `cron.runNow`, `sessions.events` 7 메서드 추가. `RpcDeps.channels?: ChannelRegistry` / `cron?: CronRegistry` 옵셔널 — 미주입 시 각각 빈 배열 반환 (UI 는 정상 렌더).
  - **플랫폼 배선**: `agent gateway start` 가 `<stateDir>/state/devices.json` 경로로 `DeviceAuthStore` 자동 초기화. `webappDir` 옵션 제공 시 `/ui/*` 정적 서빙 활성화.
  - **테스트**: +13 (control-plane/gateway/device-auth.test.ts — enroll idempotency, pubkey shape, session token TTL, tamper detection, revoke, challenge replay/pin, cross-instance persistence, TokenAuth master fallback, TokenAuth device fallback).
- **v0.7.0 (2026-04-25)** — Channels/Cron 실데이터 공급 + Reasoning trigger #3 구현 + device CLI 추가 (구현 리포 커밋 `6e728ac`/`c88aba0`/`a93b65a`/`d05a7c0`):
  - **신규 §4 `[C2']` PlatformChannelRegistry** ([packages/control-plane/src/gateway/platform-channel-registry.ts](D:\ai\agent-platform\packages\control-plane\src\gateway\platform-channel-registry.ts)): `ChannelAdapter` 컨트랙트 breaking 없이 wrapper 방식으로 status 파생. register/recordEvent/recordError/deregister 이벤트 기반 + `refreshHealth(id)` 온디맨드. platform.ts 가 WebChat 부팅 시 `register('webchat',…)`, onMessage 마다 `recordEvent`, catch 에서 `recordError`, shutdown 에서 `deregister`. `RpcDeps.channels = platform.channels` 로 주입 — `channels.list` / `channels.status` RPC 가 실 데이터 반환. 단위 테스트 +9.
  - **신규 §4 `[C2'']` SchedulerService** (`packages/scheduler/` 패키지 신규, node-cron 3.0 + workflow deps): CronTask discriminated union (chat/bash/workflow) + `TaskRunner` 인터페이스 + 3 runner — `ChatTaskRunner` (platform handler 직접 호출, EGO 자동 경유, `sessionStrategy: 'pinned'|'fresh'`), `BashTaskRunner` (ToolSandbox + `ownerPolicy('cron-<id>')` 경유, 직접 spawn 금지), `WorkflowTaskRunner` (`executeWorkflow` 래핑, sandbox 1회 acquire per workflow). tasks.json JSON5 스타일 + 중복 id 거절. 단일동시성 정책 (overlap 시 스케줄 fire 는 skip, `runNow` 는 throw). 인메모리 실행 이력 (재시작 시 초기화). `RpcDeps.cron = platform.scheduler` 로 주입 — `cron.list` / `cron.runNow` RPC 가 실 데이터 반환. 단위 테스트 +22 (json-task-store 11 + scheduler 11).
  - **§8 R3 PlanExecuteExecutor — replan 트리거 #3 구현**: `agent-orchestration.md` §4.4 의 세 번째 트리거 (egoRelevance>0.8 + goalUpdates 비어있지 않음) 구현. EGO `Cognition` + `GoalUpdate[]` 가 metadata `_egoCognition` / `_egoGoalUpdates` 로 흐르고 `AgentRunner` 가 `ReasoningContext.egoCognition` / `goalUpdates` 로 surface. 초기 plan 직후 조건 충족 시 재계획 1회 (reason=`goal_updates_high_relevance`) — `replanLimit` 공유로 트리거 #1 과 합쳐도 상한 초과 없음, 성공 step id 승계 규칙 동일. `TRIGGER_3_REL_THRESHOLD = 0.8` 상수. 단위 테스트 +5 (plan-execute-executor.test.ts 4 + agent-runner.test.ts 1 — metadata 추출 회귀 커버).
  - **§8 ReasoningContext shape 확장**: `egoCognition?: Cognition`, `goalUpdates?: GoalUpdate[]` 추가. `_egoCognition` / `_egoGoalUpdates` 가 Enrichment convention (§8.4) 에 편입.
  - **§5 [P1] 메시지 재조립**: `effectiveMsg` 가 이전 v0.6 에선 `_egoPerception` 만 부착 → v0.7 부터 `_egoCognition` + (비어있지 않은 경우) `_egoGoalUpdates` 까지 한꺼번에 부착. 재조립 조건이 `record.thinking?.perception` → `record.thinking` 으로 느슨해짐 (Cognition 은 thinking 이 있으면 항상 같이 전달됨).
  - **신규 CLI `agent device {list,revoke}`** ([packages/cli/src/commands/device.ts](D:\ai\agent-platform\packages\cli\src\commands\device.ts)): `DeviceAuthStore` 직접 열어 `devices.json` 만으로 동작 (gateway 실행 불필요). `device list` 는 deviceId·name·enrolledAt·lastSeenAt 테이블 또는 `--json`. `device revoke <id>` 는 즉시 삭제 + `verifySessionToken` 이후 `device revoked` 사유로 기존 세션 토큰 거절. 이전에는 `devices.json` 수동 편집만 가능.
  - **§14.6 Webapp Control 폴링 주의 갱신**: "registered adapter 없음" 상태는 더 이상 해당되지 않음 — `channels.list` 는 실제 기동된 어댑터, `cron.list` 는 tasks.json 에 정의된 태스크를 반환.
  - **§12.1 재생성 가이드**: 신규 블록 `[C2']` / `[C2'']` 두 행 추가, `[P1]` 체크포인트에 새 metadata 키 + scheduler start/stop 순서 반영, `[R3]` 체크포인트에 `TRIGGER_3_REL_THRESHOLD` 상수 명시.
  - **테스트 누적**: 685 → 722 (+37: registry 9 + scheduler 22 + replan #3 5 + agent-runner metadata 1). 기존 failing 6 (skills/observability, pre-existing) 변동 없음.
