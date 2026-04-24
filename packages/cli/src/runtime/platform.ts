import { dirname } from 'node:path';
import type { Contracts, EgoFullConfig, SessionPolicy, StandardMessage } from '@agent-platform/core';
import type { ModelAdapter } from '@agent-platform/agent-worker';
import {
  ApiGateway,
  DeviceAuthStore,
  PlatformChannelRegistry,
  RuleRouter,
  SessionStore,
  type MessageHandler,
} from '@agent-platform/control-plane';
import {
  EgoLayer,
  FileGoalStore,
  FilePersonaManager,
  SqliteAuditLog,
} from '@agent-platform/ego';
import {
  HashEmbedder,
  PalaceMemorySystem,
  type EmbeddingProvider,
} from '@agent-platform/memory';
import {
  AgentRunner,
  EmbedderStepMatcher,
  HybridReasoner,
  InProcessSandbox,
  LiveToolRegistry,
  PolicyCapabilityGuard,
  buildDefaultTools,
  ownerPolicy,
  skillAuthoringTools,
  type AgentTool,
  type DefaultToolsConfig,
} from '@agent-platform/agent-worker';
import {
  BUILTIN_SKILLS_ROOT,
  LocalSkillRegistry,
  mountInstalledSkills,
  seedBuiltinSkills,
  type LoadedSkillTool,
} from '@agent-platform/skills';
import type { Permission } from '@agent-platform/core';
import { WebChatAdapter } from '@agent-platform/channel-webchat';
import {
  BashTaskRunner,
  ChatTaskRunner,
  SchedulerService,
  WorkflowTaskRunner,
  loadTasksFromFile,
} from '@agent-platform/scheduler';
import {
  InMemoryMetricsSink,
  SqliteTraceLog,
  setupTelemetry,
  withSpan,
} from '@agent-platform/observability';
import { NoopTraceLogger } from '@agent-platform/core';

export interface PlatformConfig {
  sessionsDbPath: string;
  palaceRoot: string;
  egoConfig: EgoFullConfig;
  egoLlm?: Contracts.EgoLlmAdapter;
  modelAdapter: ModelAdapter;
  /**
   * Optional reasoner override (ADR-009). Defaults to a `HybridReasoner` that
   * routes per-turn between ReAct and Plan-and-Execute based on complexity.
   * Pass a custom reasoner when you need a different composition (e.g. ReAct-only
   * for roll-out, or a remote reasoner).
   */
  reasoner?: Contracts.Reasoner;
  /**
   * Tools exposed to the reasoner. When empty, ReAct degenerates to a single
   * LLM call (pre-ADR-009 behavior) and Plan-Execute is unreachable.
   *
   * Use `buildDefaultTools()` for the common opt-in:
   *
   *   tools: buildDefaultTools({ fsRead: [process.cwd()], webFetch: ['github.com'] })
   *
   * For Docker-backed `bash.run`, import `bashTool` directly and append.
   */
  tools?: AgentTool[];
  /**
   * Opt-in default tool roots/domains. When provided, `buildDefaultTools()` is
   * invoked internally and the result is merged with `tools` (user `tools`
   * wins on name conflicts). Intended for callers like `agent gateway start`
   * that want zero-config TUI usage without forcing each entry point to
   * reconstruct the preset list. Pass `{}` to opt into the helper without
   * actually enabling any tool.
   */
  defaultToolsConfig?: DefaultToolsConfig;
  /**
   * U10 Phase 3: enable agent-authored skills.
   *
   * When `skillInstallRoot` is set, `startPlatform` spins up a
   * `LocalSkillRegistry` at that path, mounts every already-installed skill
   * into the `LiveToolRegistry`, and (if `enableSkillAuthoring` is true —
   * the default when `skillInstallRoot` is given) exposes `skill.create`,
   * `skill.list`, `skill.remove`, `skill.reload` as agent tools. The
   * owner-trust requirement on `skill.create` (filesystem.write permission)
   * is enforced by `PolicyCapabilityGuard` — only owner sessions can author
   * new skills.
   */
  skillInstallRoot?: string;
  /** Defaults to `true` when `skillInstallRoot` is set. Explicit `false` disables authoring tools only. */
  enableSkillAuthoring?: boolean;
  /**
   * Optional system prompt for the agent LLM. When set, passed through to
   * `AgentConfig.systemPrompt` — PromptBuilder uses it as the base instead of
   * its built-in "helpful AI assistant" default. `agent gateway start`
   * loads this from `<stateDir>/system-prompt.md` automatically if present.
   */
  agentSystemPrompt?: string;
  /**
   * Optional planner model for Plan-and-Execute (defaults to `modelAdapter`).
   * A cheaper/faster model (e.g. Haiku) is a good choice here.
   */
  plannerModel?: ModelAdapter;
  /**
   * Force-disable plan-execute routing. Useful for canary/rollout: starts as
   * ReAct-only while keeping the reasoner infrastructure in place.
   */
  disablePlanExecute?: boolean;
  embedder?: EmbeddingProvider;
  gatewayPort?: number;
  /**
   * Host/interface the gateway HTTP server binds to. Defaults to
   * `'127.0.0.1'` via the ApiGateway config default — matches ADR-004's
   * single-owner local gateway and guarantees IPv4 availability (Node on
   * some Windows setups otherwise binds `::1` only when no host is given).
   * Override with `AGENT_GATEWAY_HOST` at the CLI layer.
   */
  gatewayHost?: string;
  gatewayAuthTokens?: string[];
  webchatPort?: number;
  webchatOwnerIds?: string[];
  /**
   * Path to a built webapp dist directory (Vite output of
   * `packages/webapp`). When set, the gateway serves the SPA at `/ui/*`
   * and exposes `/device/{enroll,challenge,assert}` for browser clients.
   */
  webappDir?: string;
  /**
   * Path to the device-auth JSON store (ed25519 pubkeys + session secret).
   * Required when `webappDir` is provided; defaults to
   * `<stateDir>/state/devices.json` at the CLI layer.
   */
  devicesFile?: string;
  telemetry?: {
    serviceName?: string;
    exporter?: 'console' | 'memory' | 'none';
  };
  /**
   * Per-turn debug trace logger. When omitted, `startPlatform` creates a
   * `SqliteTraceLog` at `traceDbPath` (unless `AGENT_TRACE=0`, in which case
   * a `NoopTraceLogger` is wired). Inject a custom instance (including
   * `NoopTraceLogger`) to override.
   */
  traceLogger?: Contracts.TraceLogger;
  /** Path to the SQLite trace DB (required if `traceLogger` is omitted). */
  traceDbPath?: string;
  /** Days of trace retention; rows older than this are pruned on boot. */
  traceRetentionDays?: number;
  /**
   * Path to the cron scheduler task file. When the file exists it is parsed
   * into `CronTask[]` and handed to `SchedulerService`; a missing file is
   * equivalent to "no scheduled tasks" (scheduler still boots, `cron.list`
   * RPC returns `[]`). Defaults to `<stateDir>/scheduler/tasks.json` at the
   * CLI layer.
   */
  tasksFile?: string;
  /**
   * Base dir for resolving relative `workflow.path` values in cron tasks.
   * Defaults to the tasksFile's parent directory.
   */
  workflowBaseDir?: string;
}

export interface PlatformHandles {
  sessions: SessionStore;
  router: RuleRouter;
  memory: PalaceMemorySystem;
  ego: EgoLayer;
  audit: SqliteAuditLog;
  goals: FileGoalStore;
  persona: FilePersonaManager;
  runner: AgentRunner;
  gateway: ApiGateway;
  webchat: WebChatAdapter;
  /**
   * Registry of running channel adapters. Powers RPC `channels.list` /
   * `channels.status`. Gateway-cli's `RpcDeps.channels` accepts this
   * directly (structurally-compatible `list()`/`get()` shape).
   */
  channels: PlatformChannelRegistry;
  /**
   * Cron scheduler. Empty when no `tasks.json` is present; otherwise loaded +
   * started during `startPlatform()`. Gateway-cli's `RpcDeps.cron` accepts
   * this directly (structurally-compatible `list()` / `runNow()` shape).
   */
  scheduler: SchedulerService;
  metrics: InMemoryMetricsSink;
  /**
   * The same handler wired into ApiGateway. Exposed so alternate entry points
   * (e.g. JSON-RPC `chat.send` in gateway-cli) can invoke the EGO + AgentRunner
   * path directly, preserving streaming.
   */
  handler: MessageHandler;
  traceLogger: Contracts.TraceLogger;
  ports: { gateway: number; webchat: number };
  shutdown(): Promise<void>;
}

/**
 * Wire every component together and boot the gateway + webchat server.
 * Returns once both are listening.
 */
export async function startPlatform(config: PlatformConfig): Promise<PlatformHandles> {
  const telemetry = setupTelemetry({
    serviceName: config.telemetry?.serviceName ?? 'agent-platform',
    exporter: config.telemetry?.exporter ?? 'none',
  });

  const metrics = new InMemoryMetricsSink();

  // ─── Trace logger (pipeline block debug) ─────────────────────────────────
  // Default: SqliteTraceLog at config.traceDbPath. Opt out via
  // `AGENT_TRACE=0` (→ NoopTraceLogger) or by injecting `config.traceLogger`
  // directly. Retention defaults to 14 days; env var AGENT_TRACE_RETENTION_DAYS
  // overrides.
  const traceEnabled = process.env['AGENT_TRACE'] !== '0';
  const traceLogger: Contracts.TraceLogger =
    config.traceLogger ??
    (traceEnabled && config.traceDbPath
      ? new SqliteTraceLog({
          storePath: config.traceDbPath,
          retentionDays:
            config.traceRetentionDays ??
            Number(process.env['AGENT_TRACE_RETENTION_DAYS'] ?? 14),
        })
      : new NoopTraceLogger());

  const sessions = new SessionStore(config.sessionsDbPath);
  const router = new RuleRouter(sessions, { defaultAgentId: 'default', traceLogger });

  const embedder = config.embedder ?? new HashEmbedder(128);
  const memory = new PalaceMemorySystem({
    root: config.palaceRoot,
    embedder,
  });
  await memory.init();

  const audit = new SqliteAuditLog(config.egoConfig.audit.storePath);
  const goals = new FileGoalStore(config.egoConfig.goals.storePath);
  const persona = new FilePersonaManager({
    storePath: config.egoConfig.persona.storePath,
    snapshot: config.egoConfig.persona.snapshot,
  });

  const ego = new EgoLayer(config.egoConfig, {
    memory,
    goals,
    persona,
    audit,
    traceLogger,
    ...(config.egoLlm ? { llm: config.egoLlm } : {}),
  });

  // ─── ADR-009 + U10: reasoning + tool + skill wiring ──────────────────────
  // Tool assembly order (later overrides earlier on name conflicts):
  //   1. buildDefaultTools(defaultToolsConfig)      — fs.read/write/web.fetch presets
  //   2. explicit config.tools                      — caller overrides
  //   3. skill-authoring tools (skill.create/...)   — when enableSkillAuthoring
  //   4. pre-installed skill tools                  — mounted from skillInstallRoot
  //
  // Everything is consolidated into a single `LiveToolRegistry` whose backing
  // Map is passed to `InProcessSandbox` + `PolicyCapabilityGuard`. Both hold a
  // live ref, so tools registered later (via `skill.create` → `remount`) are
  // visible without tearing down the stack. `AgentRunner` snapshots
  // `registry.descriptors()` on every turn (Phase 4.3).
  const liveRegistry = new LiveToolRegistry();
  if (config.defaultToolsConfig) {
    liveRegistry.registerAll(buildDefaultTools(config.defaultToolsConfig));
  }
  if (config.tools?.length) liveRegistry.registerAll(config.tools);

  const policies = new Map<string, SessionPolicy>();
  const toolMap = liveRegistry.asMap();
  const innerGuard = new PolicyCapabilityGuard(policies, toolMap);
  // Lazy-populate an owner-level SessionPolicy on first lookup. The platform
  // today is single-owner (ADR-004), so we default every session to owner trust.
  const capabilityGuard: Contracts.CapabilityGuard = {
    check(sessionId, toolName, args) {
      if (!policies.has(sessionId)) policies.set(sessionId, ownerPolicy(sessionId));
      return innerGuard.check(sessionId, toolName, args);
    },
  };
  const toolSandbox = new InProcessSandbox(toolMap);

  // U10 Phase 3: skill registry + authoring tools + initial mount of already
  // installed skills. The `remount` callback re-scans the install dir and
  // registers any tools it finds into the live registry — skill.create calls
  // this on success so newly-authored tools appear on the next turn.
  let skillRegistry: LocalSkillRegistry | undefined;
  const remountInstalledSkills = async (): Promise<string[]> => {
    if (!skillRegistry) return [];
    const { tools: mounted, errors } = await mountInstalledSkills(skillRegistry);
    if (errors.length > 0) {
      for (const e of errors) {
        traceLogger.event({
          traceId: 'platform-init',
          block: 'P1',
          event: 'skill_mount_error',
          timestamp: Date.now(),
          payload: { skillId: e.skillId, error: e.error.message },
        });
      }
    }
    // Preserve non-skill tools (base + user-provided + skill-authoring); the
    // replace call with preserveNames clears old skill-backed entries and
    // repopulates from the current disk state.
    const nonSkillNames = new Set<string>();
    for (const t of liveRegistry.snapshot()) {
      if (!t.name.includes('.') || t.name.startsWith('fs.') || t.name.startsWith('web.') || t.name.startsWith('skill.')) {
        // Heuristic: preserve platform-wired tools. Skill tools typically use
        // dotted names that do not start with fs./web./skill.
      }
      nonSkillNames.add(t.name);
    }
    const skillTools: AgentTool[] = [];
    for (const mount of mounted.values()) {
      const adapted = adaptSkillTool(mount.tool);
      if (!nonSkillNames.has(adapted.name)) skillTools.push(adapted);
    }
    liveRegistry.registerAll(skillTools);
    return liveRegistry.snapshot().map((t) => t.name);
  };

  if (config.skillInstallRoot) {
    skillRegistry = new LocalSkillRegistry({
      installRoot: config.skillInstallRoot,
      searchPaths: [config.skillInstallRoot],
    });

    // Seed first-party builtin skills (idempotent). Runs before any mounting
    // so both user-installed and builtin skills flow through the same
    // `mountInstalledSkills` path below.
    const seedResult = await seedBuiltinSkills(
      config.skillInstallRoot,
      BUILTIN_SKILLS_ROOT,
      {
        logger: (m) =>
          traceLogger.event({
            traceId: 'boot',
            block: 'P1',
            event: 'skill_seed',
            timestamp: Date.now(),
            payload: { message: m },
          }),
      },
    );
    if (
      seedResult.seeded.length > 0 ||
      seedResult.upgraded.length > 0 ||
      seedResult.skipped.length > 0
    ) {
      traceLogger.event({
        traceId: 'boot',
        block: 'P1',
        event: 'skill_seed_summary',
        timestamp: Date.now(),
        payload: {
          seeded: seedResult.seeded,
          upgraded: seedResult.upgraded,
          skipped: seedResult.skipped,
        },
      });
    }

    const enableAuthoring = config.enableSkillAuthoring !== false;
    if (enableAuthoring) {
      liveRegistry.registerAll(
        skillAuthoringTools({
          registry: skillRegistry,
          remount: remountInstalledSkills,
        }),
      );
    }
    // Initial mount — done before runner construction so the first turn
    // already sees installed skill-backed tools (including the just-seeded
    // builtins).
    await remountInstalledSkills();
  }

  // Share the palace's embedder with the PlanExecuteExecutor's semantic step
  // matcher — zero extra network/CPU cost, and keeps both subsystems on the
  // same embedding space so memory ingest and replan preservation agree on
  // "semantically similar" meaning the same thing.
  const stepMatcher = new EmbedderStepMatcher((text) => embedder.embed(text));

  const defaultReasoner =
    config.reasoner ??
    new HybridReasoner(
      config.modelAdapter,
      {
        capabilityGuard,
        toolSandbox,
        // The sessionPolicy here is a placeholder passed to plan-execute's sandbox
        // acquire() — per-session policy is resolved by `capabilityGuard.check()`
        // above. This single instance is sufficient for single-owner local dev.
        sessionPolicy: ownerPolicy('__default__'),
        traceLogger,
        stepMatcher,
        ...(config.plannerModel ? { plannerModel: config.plannerModel } : {}),
      },
      config.disablePlanExecute ? { disablePlanExecute: true } : {},
    );

  const runner = new AgentRunner(
    sessions,
    config.modelAdapter,
    {
      agentId: 'default',
      ...(config.agentSystemPrompt ? { systemPrompt: config.agentSystemPrompt } : {}),
    },
    {
      memory,
      reasoner: defaultReasoner,
      // U10 Phase 4.3: use the live registry so per-turn snapshots pick up
      // tools registered after gateway boot (e.g. via skill.create).
      toolRegistry: liveRegistry,
      capabilityGuard,
      toolSandbox,
      sessionPolicy: ownerPolicy('__default__'),
      traceLogger,
    },
  );

  const handler: MessageHandler = async (msg, ctx) => {
    const p1Start = Date.now();
    traceLogger.event({
      traceId: ctx.traceId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      block: 'P1',
      event: 'enter',
      timestamp: p1Start,
    });
    let egoActionTaken: string | undefined;
    try {
    return await withSpan(
      'platform.handleTurn',
      async () => {
        // ADR-010: phase `ego_judging` fires before EGO processing starts.
        // When EGO is disabled (state=off) the layer short-circuits and the
        // phase still serves as a sentinel for "server accepted the work".
        ctx.emitPhase?.('ego_judging');

        // 1. EGO judgment
        const record = await withSpan(
          'platform.ego',
          async () => ego.processDetailed(msg, { sessionId: ctx.sessionId, agentId: ctx.agentId }),
          { traceId: ctx.traceId },
        );
        egoActionTaken = record.decision.action;
        metrics.recordEgoDecision({
          fastExit: record.fastExit,
          action: record.decision.action,
          confidence: record.metadata?.confidenceScore ?? 0,
          costUsd: record.costUsd,
          pipelineMs: record.pipelineMs,
        });

        if (record.decision.action === 'direct_response') {
          const text =
            record.decision.content.type === 'text'
              ? record.decision.content.text
              : '[non-text direct response]';
          ctx.emit(text);
          return {};
        }

        // Pull perception + cognition + goalUpdates (for ComplexityRouter and
        // PlanExecuteExecutor trigger #3) and decisionId (for trace correlation)
        // into channel.metadata for downstream consumption. The enrich path
        // already attaches `_egoDecisionId` + `_egoEnrichment`; we additively
        // layer `_egoPerception` / `_egoCognition` / `_egoGoalUpdates`.
        const baseMsg: StandardMessage =
          record.decision.action === 'enrich' ? record.decision.enrichedMessage : msg;
        const effectiveMsg: StandardMessage = record.thinking
          ? {
              ...baseMsg,
              channel: {
                ...baseMsg.channel,
                metadata: {
                  ...baseMsg.channel.metadata,
                  _egoPerception: record.thinking.perception,
                  _egoCognition: record.thinking.cognition,
                  ...(record.thinking.goalUpdates && record.thinking.goalUpdates.length > 0
                    ? { _egoGoalUpdates: record.thinking.goalUpdates }
                    : {}),
                  ...(record.metadata?.egoDecisionId
                    ? { _egoDecisionId: record.metadata.egoDecisionId }
                    : {}),
                },
              },
            }
          : baseMsg;

        // 2. Agent turn
        const result = await withSpan(
          'platform.agent',
          async () => runner.processTurn(ctx.sessionId, effectiveMsg, ctx.emit, ctx.emitPhase),
          { traceId: ctx.traceId },
        );
        metrics.recordTurn({
          traceId: ctx.traceId,
          sessionId: ctx.sessionId,
          agentId: ctx.agentId,
          channelType: msg.channel.type,
          model: config.modelAdapter.getModelInfo().model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          estimatedCostUsd: result.costUsd ?? 0,
          firstTokenLatencyMs: result.latencyMs,
          totalLatencyMs: result.latencyMs,
          toolCallCount: 0,
          toolCallLatencyMs: [],
          retryCount: 0,
          failoverTriggered: false,
          compactionTriggered: false,
        });
        return {
          ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
          ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
          ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
        };
      },
      { sessionId: ctx.sessionId },
    );
    } catch (err) {
      traceLogger.event({
        traceId: ctx.traceId,
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        block: 'P1',
        event: 'error',
        timestamp: Date.now(),
        durationMs: Date.now() - p1Start,
        error: (err as Error).message,
      });
      throw err;
    } finally {
      traceLogger.event({
        traceId: ctx.traceId,
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        block: 'P1',
        event: 'exit',
        timestamp: Date.now(),
        durationMs: Date.now() - p1Start,
        ...(egoActionTaken ? { payload: { egoAction: egoActionTaken } } : {}),
      });
    }
  };

  // Initialize device-auth whenever a store path is available. Previously this
  // was gated on `webappDir` too, but the browser can also reach `/device/*`
  // via a reverse proxy (e.g. `vite dev`) where the gateway itself doesn't
  // serve the SPA — enrollment must still work in that case.
  const devices = config.devicesFile
    ? new DeviceAuthStore({ filePath: config.devicesFile })
    : undefined;

  const gateway = new ApiGateway({
    port: config.gatewayPort ?? 0,
    ...(config.gatewayHost ? { host: config.gatewayHost } : {}),
    auth: { tokens: config.gatewayAuthTokens ?? ['dev-token'] },
    rateLimit: { capacity: 30, refillPerSecond: 2 },
    router,
    sessions,
    handler,
    ...(devices ? { devices } : {}),
    ...(config.webappDir
      ? { webapp: { dir: config.webappDir, enabled: true } }
      : {}),
  });
  const gatewayPort = await gateway.start();

  const channels = new PlatformChannelRegistry();

  const webchat = new WebChatAdapter();
  const webchatConfig = {
    type: 'webchat' as const,
    port: config.webchatPort ?? 0,
    credentials: {},
    ...(config.webchatOwnerIds ? { ownerIds: config.webchatOwnerIds } : {}),
  };
  await webchat.initialize(webchatConfig);
  channels.register('webchat', 'webchat', webchat);

  // Wire webchat → handler. When a browser message arrives, route it, invoke
  // the same handler the HTTP/WS gateway uses, and stream deltas back.
  webchat.onMessage((msg) => {
    channels.recordEvent('webchat', msg.timestamp);
    void (async () => {
      try {
        const route = await router.route(msg);
        await handler(msg, {
          sessionId: route.sessionId,
          agentId: route.agentId,
          traceId: msg.traceId,
          emit: (text) => webchat.emitDelta(msg.conversation.id, msg.traceId, text),
          traceLogger,
        });
        webchat.emitDone(msg.conversation.id, msg.traceId);
      } catch (err) {
        const errMsg = (err as Error).message;
        channels.recordError('webchat', errMsg);
        await webchat.sendMessage(msg.conversation.id, {
          type: 'text',
          text: `[error] ${errMsg}`,
        });
      }
    })();
  });

  const webchatPort = webchat.listeningPort();

  // ─── Cron scheduler (option B: chat/bash/workflow runners) ────────────────
  const scheduler = buildScheduler({
    tasksFile: config.tasksFile,
    workflowBaseDir: config.workflowBaseDir,
    handler,
    router,
    traceLogger,
    toolSandbox,
    capabilityGuard,
  });
  scheduler.start();

  return {
    sessions,
    router,
    memory,
    ego,
    audit,
    goals,
    persona,
    runner,
    gateway,
    webchat,
    channels,
    scheduler,
    metrics,
    traceLogger,
    handler,
    ports: { gateway: gatewayPort, webchat: webchatPort },
    async shutdown() {
      await scheduler.stop();
      channels.deregister('webchat');
      await webchat.shutdown();
      await gateway.stop();
      await audit.close();
      await memory.close();
      sessions.close();
      await traceLogger.close?.();
      await telemetry.shutdown();
    },
  };
}

/**
 * Build a SchedulerService from config. When `tasksFile` is missing the
 * scheduler still boots (empty task list) so `cron.list` RPC works without
 * forcing the user to create an empty file.
 */
function buildScheduler(opts: {
  tasksFile?: string;
  workflowBaseDir?: string;
  handler: MessageHandler;
  router: RuleRouter;
  traceLogger: Contracts.TraceLogger;
  toolSandbox: Contracts.ToolSandbox;
  capabilityGuard: Contracts.CapabilityGuard;
}): SchedulerService {
  const tasks = opts.tasksFile ? loadTasksFromFile(opts.tasksFile) : [];
  const workflowBaseDir =
    opts.workflowBaseDir ??
    (opts.tasksFile ? dirname(opts.tasksFile) : undefined);
  const chatRunner = new ChatTaskRunner({
    handler: opts.handler,
    router: opts.router,
    traceLogger: opts.traceLogger,
  });
  const bashRunner = new BashTaskRunner({
    toolSandbox: opts.toolSandbox,
    capabilityGuard: opts.capabilityGuard,
    policyFor: (taskId) => ownerPolicy(`cron-${taskId}`),
  });
  const workflowRunner = new WorkflowTaskRunner({
    toolSandbox: opts.toolSandbox,
    capabilityGuard: opts.capabilityGuard,
    policyFor: (taskId) => ownerPolicy(`cron-${taskId}`),
    ...(workflowBaseDir ? { workflowBaseDir } : {}),
  });
  return new SchedulerService({
    tasks,
    runners: { chat: chatRunner, bash: bashRunner, workflow: workflowRunner },
  });
}

/**
 * U10 Phase 3: shape-coerce a `LoadedSkillTool` (from @agent-platform/skills,
 * which doesn't depend on agent-worker types) into a full `AgentTool`. We
 * fill in defaults for the fields skills treat as optional.
 */
function adaptSkillTool(loaded: LoadedSkillTool): AgentTool {
  const risk = loaded.riskLevel as AgentTool['riskLevel'] | undefined;
  return {
    name: loaded.name,
    description: loaded.description ?? `Skill-backed tool: ${loaded.name}`,
    permissions: (loaded.permissions as Permission[] | undefined) ?? [],
    riskLevel: risk ?? 'low',
    inputSchema: loaded.inputSchema ?? { type: 'object', properties: {} },
    async execute(args, ctx) {
      const out = await loaded.execute(args, ctx);
      // Skill author may return a plain value; normalize into ToolResult.
      if (out && typeof out === 'object' && 'toolName' in (out as object)) {
        return out as import('@agent-platform/core').ToolResult;
      }
      return {
        toolName: loaded.name,
        success: true,
        output: JSON.stringify(out ?? null),
        durationMs: 0,
      };
    },
  };
}
