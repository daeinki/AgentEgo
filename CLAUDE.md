# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository shape

pnpm workspace with **19 packages** under `packages/` (channels nested at `packages/channels/*`). TypeScript ES modules, `strict: true` + `exactOptionalPropertyTypes: true` + `noUncheckedIndexedAccess: true`, target ES2024, `module: NodeNext`. Node ≥ 22 is required — the code relies on the built-in `node:sqlite` and does not use `better-sqlite3`.

TypeScript project references are wired in root `tsconfig.json`; every package builds with plain `tsc` into `dist/`. Avoid introducing native SQLite bindings — if you see `better-sqlite3` errors, it's coming from an unrelated global install, not this repo.

## Common commands

```bash
pnpm install                            # workspace install; .npmrc pins supported-architectures so the same node_modules works on Windows and WSL/Linux
pnpm -r run build                       # build every package (tsc project refs)
pnpm --filter @agent-platform/<pkg> run build   # single package
npx vitest run                          # run full test suite (608+ tests across packages/*/src/**/*.test.ts and packages/*/test/**/*.spec.ts)
npx vitest run packages/core            # single package
npx vitest run path/to/file.test.ts     # single file
pnpm run lint                           # oxlint .
pnpm run format                         # prettier --write . (semi, singleQuote, trailingComma=all, printWidth 100)
pnpm run typecheck                      # tsc --noEmit across workspace
```

The CLI is developed by running the entry directly with tsx — **note the `--` separator**, required so pnpm does not eat the CLI's own flags:

```bash
pnpm --filter @agent-platform/cli dev -- send "hello"
pnpm --filter @agent-platform/cli dev -- gateway start
pnpm --filter @agent-platform/cli dev -- trace list -n 5
pnpm --filter @agent-platform/cli dev -- tui
pnpm --filter @agent-platform/webapp dev        # Vite dev server for the browser dashboard (proxies to gateway)
```

## Big-picture architecture

Read `docs/architecture.md` for the full package map and data-flow diagram. The essentials:

- **Message flow**: `ChannelAdapter → MessageBus → EgoLayer (optional) → ControlPlane Router/SessionManager → AgentRunner → {MemorySystem, ToolSandbox, Observability}`. EGO has three states (`off`/`passive`/`active`) and four decision paths (`passthrough`/`enrich`/`redirect`/`direct_response`); see §3 and §4 of `docs/architecture.md`.
- **Contract-first boundaries**: every cross-package seam is an interface in `@agent-platform/core/contracts` (e.g. `ChannelAdapter`, `SessionManager`, `Router`, `EgoLayer`, `MemorySystem`, `PromptBuilder`, `ModelAdapter`, `CapabilityGuard`, `ToolSandbox`, `SkillRegistry`, `GoalStore`, `PersonaManager`, `AuditLog`). When extending, add or replace a contract impl rather than widening an existing class.
- **`@agent-platform/core`**: all shared TypeBox schemas, contracts, branded IDs (uuid v7), ADR-006 EGO state helpers, and errors live here. Everything else imports from it. Two subpath exports exist and must be kept stable: `@agent-platform/core/phase` and `@agent-platform/core/phase-format` — TUI and webapp both render PhaseLine through `formatPhase`, so changing its output changes both UIs.
- **Two operator surfaces (ADR-008 / ADR-010)** both speak the same JSON-RPC 2.0 over WebSocket (`/rpc`) served by `@agent-platform/gateway-cli`:
  - **TUI** (`packages/tui`, Ink + React) authenticates with `Authorization: Bearer <master>`.
  - **Webapp** (`packages/webapp`, Vite + Lit 3) uses ed25519 **device-identity enrollment** → short-lived **HMAC session token** passed as a `bearer.<token>` WebSocket subprotocol. `DeviceAuthStore` in `control-plane/src/gateway/device-auth.ts` persists devices to `<stateDir>/state/devices.json` (mode 0o600).
  - Shared RPC surface: `chat.send/history`, `sessions.list/events/reset`, `overview.status`, `channels.list/status`, `instances.list`, `cron.list/runNow`, `gateway.health/shutdown`, plus `chat.phase` server→client notification.
- **State directories** (source-of-truth map is §7 of `docs/architecture.md`): `~/.agent/ego/` (EGO config/audit), `~/.agent/memory/` (palace + wings), `<stateDir>/state/` (sessions.db, devices.json), `<stateDir>/trace/traces.db`. These roots are disjoint — never write across them from one subsystem.
- **EGO pipeline**: `packages/ego/src/layer.ts` runs S1→S7. Fast-path rules aim for ~75% passthrough in ~16 ms; deep path (LLM via `AnthropicEgoLlmAdapter`) targets ~2 s and always writes to `SqliteAuditLog`. A circuit breaker (`circuit-breaker.ts`) degrades to passthrough on consecutive failures, and `thresholds.maxCostUsdPerDay` auto-downgrades `state` when the daily cap is hit.
- **Memory**: `PalaceMemorySystem` is SQLite FTS5 + vector cosine + structure boost (weights `bm25*0.45 + vector*0.45 + boost*0.1`), with four "wings" (`personal`/`work`/`knowledge`/`interactions`). Embedders are pluggable (`HashEmbedder` offline, `HttpEmbedder` for OpenAI/Voyage/Ollama).
- **Tools / sandbox**: `agent-worker/src/tools/` has `InProcessSandbox` and `DockerSandbox` (DockerTool protocol). `bash.run` is container-forced. All tool calls go through `PolicyCapabilityGuard`.
- **Skills**: signed skill bundles under `packages/skills/builtin/` (`architecture-lookup`, `trace-lookup`) are auto-seeded; `LocalSkillRegistry` handles install/verify (SHA-256) and `mountInstalledSkills` aggregates them into the tool registry with duplicate detection.
- **Reasoning layer (ADR-009)**: `AgentRunner` delegates to a `HybridReasoner` inside `packages/agent-worker/src/reasoning/`. A `ComplexityRouter` reads `EgoThinkingResult.perception.estimatedComplexity` and routes `low → ReAct` (inline Thought/Action/Observation loop, 2 tool retries) vs `medium|high → Plan-and-Execute` (planner LLM emits JSON plan, ≤2 replans, downgrades to ReAct on exhaustion). `requestType === 'workflow_execution'` forces plan-execute. When EGO is off, a heuristic (sentence count, imperative verbs, tool-candidate count) substitutes. Steps without `dependsOn[]` currently run **sequentially** — parallel execution is opt-in for a later phase.
- **Tracing**: `SqliteTraceLog` (blocks G3/P1/E1/W1/R1–R3/M1/S1/K1/K2/X*) at `<stateDir>/trace/traces.db`. `AGENT_TRACE=0` disables; `AGENT_TRACE_RETENTION_DAYS` (default 14) controls prune-on-boot. Block-prefix convention (fixed across code and spec): `T*` TUI, `G*` Gateway, `C*` Control plane, `P*` Platform handler, `E*` EGO, `W*` AgentRunner/Prompt, `R*` Reasoner, `M*` ModelAdapter, `S*` Sandbox/CapabilityGuard, `K*` Tool/Skill registry, `X*` memory/audit/metrics.

## Design-doc companion (`../../claude/` relative to this repo, i.e. `/mnt/d/ai/claude/`)

This code repo has a **sibling design-document repo** at `/mnt/d/ai/claude/` whose docs are the authoritative spec for intent and trade-offs. Code in `packages/` is authoritative for *current behavior*; the specs are authoritative for *why it was done this way*. When a change crosses a public contract (channel adapters, gateway routes, RPC method set, phase event schema, storage paths, auth model, EGO vocabulary), update the matching section of the spec in the same change.

Read the specs in this dependency order:

1. **`harness-engineering.md`** (v0.7, top-level system design) — ADR-001…ADR-010. Load-bearing ADRs:
   - **ADR-001** — split control plane and worker into separate processes.
   - **ADR-004** — least privilege by default; single-owner master token is the root of trust, `PolicyCapabilityGuard` enforces per-tool capabilities.
   - **ADR-005** — EGO layer lives between message bus and control plane; uses the control plane as a tool, never modifies it.
   - **ADR-006** — single `state: 'off'|'passive'|'active'` (replaced v0.2's `enabled` + `mode`).
   - **ADR-007** — `Goal` interface fixed shape, stored in `~/.agent/ego/goals.json`.
   - **ADR-008** — daemon/client split (tmux-style): one long-running `ApiGateway` + thin clients over `WS /rpc` JSON-RPC 2.0. Port defaults to **18790** to avoid OpenClaw's 18789. State dir layout `~/.agent/{state,run,logs,memory,ego}` is contract, not convention.
   - **ADR-009** — hybrid reasoning layer (ReAct + Plan-and-Execute) inside the worker; details in `agent-orchestration.md`.
   - **ADR-010** — webapp + ed25519 device-identity enroll → HMAC session token; master Bearer is for **enrollment bootstrap only**. `Sec-WebSocket-Protocol: bearer.<token>` is the WS auth transport because browsers can't set `Authorization` on WS.
2. **`ego-design.md`** (v0.2) — the two-tier pipeline. Fast path (S1 Intake + S2 Normalize, rules only, ~16 ms, ~75% passthrough target). Deep path fuses S3+S4+S5 (perception+cognition+judgment) into a **single** LLM call returning structured JSON — this is deliberate cost/latency design, don't split it. Also defines the `ComplexityLevel` buckets (`trivial|simple|moderate|complex|multi_step`) and the threshold-override rule that forces passthrough when `confidence < minConfidenceToAct`.
3. **`ego-persona.md`** — persona as `seed` + `learned` + `snapshot` (text injected into LLM calls). `FilePersonaManager.evolve` applies the evolution rules in §4.
4. **`visualize_architecture.md`** — runtime block diagrams using the same `T*/G*/C*/P*/E*/W*/R*/M*/S*/K*/X*` identifiers that the trace log uses. §13 (TraceLogger) is the canonical naming spec; §14/§15 cover webapp + phase-format sharing.
5. **`agent-orchestration.md`** — ADR-009 details: `ReasoningMode`, `ComplexityRouter`, the two executor classes, and the OTel span layout (`reasoning.step` / `reasoning.plan` / `reasoning.replan` nested under `agent.turn`, with `egoDecisionId` as attribute so EGO audit and reasoning traces can be joined).
6. **`current_process.md`** — the implementation-status ledger. When you add or remove a package, update this before the other docs.

### Cross-document invariants (don't let these drift)

- EGO decision vocabulary is exactly four strings — `passthrough`, `enrich`, `redirect`, `direct_response` — snake_case in JSON and in TypeScript unions. If you rename one, sweep all docs + `ego.json` + every EGO-related file in one change.
- EGO LLM vs Agent LLM are deliberately separate models: EGO = Haiku-class, temp 0.1, JSON output, ~1024 tokens; Agent = Sonnet-class, temp 0.7, free text. The cost model in `ego-design.md` §8 assumes this split.
- `PhaseIndicator { phase, elapsedMs, toolName?, stepIndex?, totalSteps?, attemptNumber? }` and `formatPhase` live in `@agent-platform/core/phase-format` and are consumed verbatim by TUI `<PhaseLine>` and webapp `<phase-line>` — one source, two renderers.
- JSON in markdown specs is **JSON5** (comments, trailing commas allowed). The `.json` config files in the repo root and under `~/.agent/` are **strict JSON** — strip comments when syncing an example into a real config.
- Spec docs use a header block `> 문서 버전 / 작성일 / 상위 문서`. Bump version and date on substantive edits; preserve `상위 문서` — that's how the dependency graph above is encoded.
- OpenClaw (`github.com/openclaw/openclaw`) is the prior-art system being improved on. Many ADRs are framed as "OpenClaw 교훈" (OpenClaw lessons) — keep that framing when adding ADRs that respond to the same prior art.

## Conventions worth knowing

- **Commit style** (follow recent `git log`): lowercase `scope:` prefix (`ego+agent-worker:`, `tui:`, `webapp:`, `docs:`) then an imperative clause. Example: `ego+agent-worker: migrate Anthropic SDK 0.39 → 0.88, target Opus 4.7`.
- **Language**: spec docs in `/mnt/d/ai/claude/` are written in **Korean**; match that tone/language when editing them. Code comments and this CLAUDE.md may be English.
- **Model defaults**: Anthropic by default (`claude-sonnet-4-20250514` agent, `claude-haiku-4-5-20251001` EGO). Setting `AGENT_MODEL` to anything not starting with `claude-` auto-selects the OpenAI adapter; override explicitly with `AGENT_PROVIDER`. The Anthropic SDK was recently migrated 0.39 → 0.88 — keep usage on the new API shape.
- **Optional peers**: `@whiskeysockets/baileys` (WhatsApp) is an optional peer; don't import from the WhatsApp channel elsewhere without guarding.
- **No editorial prose in `MEMORY.md`-style files**. This repo keeps `docs/` as the source of truth; avoid creating parallel top-level markdown unless the task asks for it.
