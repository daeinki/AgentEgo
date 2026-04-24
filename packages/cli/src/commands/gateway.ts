import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import type { Contracts, EgoFullConfig } from '@agent-platform/core';
import type { DefaultToolsConfig } from '@agent-platform/agent-worker';
import { createEgoLlmAdapter, loadEgoConfig } from '@agent-platform/ego';
import {
  AlreadyRunningError,
  clearPidFile,
  currentPlatform,
  defaultDaemonCommand,
  defaultServiceLabel,
  detachGateway,
  mountRpcOnGateway,
  readPidFile,
  resolveGatewayPaths,
  resolveRunning,
  resolveServiceAdapter,
  writePidFile,
  writePortFile,
  type GatewayPaths,
  type InstallOptions as ServiceInstallOptions,
} from '@agent-platform/gateway-cli';
import { startPlatform } from '../runtime/platform.js';
import { createModelAdapter } from '../runtime/model-adapter.js';

interface GatewayStartOptions {
  port?: string;
  host?: string;
  authToken?: string;
  detach?: boolean;
  foreground?: boolean;
  webappDir?: string;
  noWebapp?: boolean;
}

interface GatewayConnectOptions {
  host?: string;
  port?: string;
  authToken?: string;
  timeout?: string;
}

export async function gatewayStartCommand(options: GatewayStartOptions): Promise<void> {
  const paths = resolveGatewayPaths();
  await ensureStateDirs(paths);

  // Detach mode: fork ourselves as a detached daemon and exit once the child
  // publishes its port. The child re-enters this command with --foreground.
  if (options.detach) {
    await handleDetach(paths, options);
    return;
  }

  // Foreground (or the detached child re-entering via --foreground): bail if
  // someone else is already running.
  const running = await resolveRunning(paths);
  if (running) {
    console.error(
      `[gateway] already running at pid ${running.pid} on port ${running.port}. Use 'agent gateway stop' first.`,
    );
    process.exit(1);
  }

  const egoConfig = (await loadEgoConfig()) ?? defaultActiveEgoConfig(paths);
  const model = createModelAdapter();
  const port = options.port ? Number(options.port) : Number(process.env['AGENT_GATEWAY_PORT'] ?? 18790);
  const host = process.env['AGENT_GATEWAY_HOST'];
  const authToken = options.authToken ?? process.env['AGENT_GATEWAY_TOKEN'] ?? 'dev-token';

  // Wire the EGO LLM adapter when EGO is enabled. `createEgoLlmAdapter`
  // runs env-var preflight on apiKey (primary + fallback), validates the
  // provider, and composes a FallbackEgoLlmAdapter when a fallback block
  // is present. Any failure aborts startup — the documented G3→P1→E1
  // deep path is a load-bearing promise of the default config and must
  // not silently degrade. Users who want EGO off should set
  // `state: "off"` in ~/.agent/ego/ego.json.
  let egoLlm: Contracts.EgoLlmAdapter | undefined;
  if (egoConfig.state !== 'off' && egoConfig.llm) {
    try {
      egoLlm = await createEgoLlmAdapter(egoConfig.llm);
    } catch (err) {
      console.error(`[gateway] FATAL: ${(err as Error).message}`);
      console.error(
        `  EGO state is '${egoConfig.state}' and requires a working LLM adapter.\n` +
          `  Fix: set the referenced env var, or set ego.state='off' in ~/.agent/ego/ego.json.`,
      );
      process.exit(1);
    }
  }

  console.log(`[gateway] starting on ${host ?? '127.0.0.1'}:${port}...`);
  console.log(`[gateway] state dir: ${paths.stateDir}`);

  const agentSystemPrompt = await loadOptionalSystemPrompt(
    join(paths.stateDir, 'system-prompt.md'),
  );

  const webappDir = options.noWebapp ? undefined : resolveWebappDir(options.webappDir);

  const platform = await startPlatform({
    sessionsDbPath: paths.sessionsDb,
    palaceRoot: paths.palaceRoot,
    egoConfig,
    ...(egoLlm ? { egoLlm } : {}),
    modelAdapter: model,
    gatewayPort: port,
    ...(host ? { gatewayHost: host } : {}),
    gatewayAuthTokens: [authToken],
    traceDbPath: paths.traceDb,
    defaultToolsConfig: resolveDefaultToolsConfig(paths.stateDir),
    skillInstallRoot: join(paths.stateDir, 'skills'),
    devicesFile: join(paths.stateDir, 'state', 'devices.json'),
    tasksFile: join(paths.stateDir, 'scheduler', 'tasks.json'),
    ...(webappDir ? { webappDir } : {}),
    ...(agentSystemPrompt ? { agentSystemPrompt } : {}),
  });

  // Publish PID + port so `gateway stop/status/logs` can find us.
  await writePidFile(paths, {
    pid: process.pid,
    port: platform.ports.gateway,
    startedAt: Date.now(),
  });
  await writePortFile(paths, platform.ports.gateway);

  const modelInfo = model.getModelInfo();

  const mounted = mountRpcOnGateway({
    gateway: platform.gateway,
    deps: {
      gateway: platform.gateway,
      sessions: platform.sessions,
      router: platform.router,
      // Invoke the exact same handler wired into ApiGateway so EGO +
      // AgentRunner run with full streaming through onChunk (forwarded as
      // `chat.delta` notifications in gateway-cli's chat.send method).
      handler: platform.handler,
      traceLogger: platform.traceLogger,
      channels: platform.channels,
      cron: platform.scheduler,
      version: '0.1.0',
      ports: platform.ports,
    },
    onShutdown: async () => {
      console.log('\n[gateway] stopping...');
      await platform.shutdown();
      await clearPidFile(paths);
      console.log('[gateway] stopped.');
      process.exit(0);
    },
  });

  console.log(`[gateway] listening`);
  console.log(`  http   http://127.0.0.1:${platform.ports.gateway}`);
  console.log(`  ws     ws://127.0.0.1:${platform.ports.gateway}/ws   (webchat envelope)`);
  console.log(`  rpc    ws://127.0.0.1:${platform.ports.gateway}/rpc  (JSON-RPC 2.0)`);
  if (webappDir) {
    console.log(`  ui     http://127.0.0.1:${platform.ports.gateway}/ui/  (SPA — ${webappDir})`);
  } else if (options.noWebapp) {
    console.log(`  ui     (disabled via --no-webapp)`);
  } else {
    console.log(
      `  ui     (not served — run 'pnpm --filter @agent-platform/webapp build' or pass --webapp-dir)`,
    );
  }
  console.log(`  auth   Bearer ${authToken}`);
  console.log(`[gateway] model: ${modelInfo.provider}/${modelInfo.model}`);
  const egoLlmInfo = egoLlm ? egoLlm.getModelInfo() : undefined;
  console.log(
    `[gateway] ego state: ${egoConfig.state}` +
      (egoLlmInfo
        ? ` (llm: ${egoLlmInfo.provider}/${egoLlmInfo.model})`
        : ` (llm: disabled)`),
  );
  console.log(`[gateway] pid ${process.pid} · press Ctrl+C to stop\n`);

  await mounted.waitForShutdown();
}

export async function gatewayStatusCommand(options: GatewayConnectOptions): Promise<void> {
  const paths = resolveGatewayPaths();
  const running = await resolveRunning(paths);
  if (!running) {
    console.log(JSON.stringify({ running: false }, null, 2));
    return;
  }
  const host = options.host ?? '127.0.0.1';
  const port = options.port ? Number(options.port) : running.port;
  try {
    const health = await rpcCall(host, port, options.authToken, 'gateway.health', {}, 5000);
    console.log(
      JSON.stringify(
        { running: true, pid: running.pid, startedAt: running.startedAt, health },
        null,
        2,
      ),
    );
  } catch (err) {
    // Process exists but RPC failed — report what we know.
    console.log(
      JSON.stringify(
        {
          running: true,
          pid: running.pid,
          startedAt: running.startedAt,
          rpcError: (err as Error).message,
        },
        null,
        2,
      ),
    );
  }
}

export async function gatewayLogsCommand(options: {
  stderr?: boolean;
  lines?: string;
}): Promise<void> {
  const paths = resolveGatewayPaths();
  const logFile = options.stderr ? paths.stderrLog : paths.stdoutLog;
  const lines = options.lines ? Number(options.lines) : 50;

  const { readFile } = await import('node:fs/promises');
  try {
    const content = await readFile(logFile, 'utf-8');
    const tail = content.trimEnd().split('\n').slice(-lines).join('\n');
    console.log(tail);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(`[gateway] no log file at ${logFile} yet`);
      process.exit(1);
    }
    throw err;
  }
}

export async function gatewayInstallCommand(options: {
  label?: string;
  port?: string;
  authToken?: string;
  start?: boolean;
}): Promise<void> {
  const paths = resolveGatewayPaths();
  await ensureStateDirs(paths);
  const adapter = resolveServiceAdapter();
  const label = options.label ?? defaultServiceLabel();

  const entry = process.argv[1];
  if (!entry || !entry.endsWith('.js')) {
    console.error(
      `[gateway] install requires the built CLI entrypoint (got ${entry ?? '<unknown>'}).`,
    );
    console.error(
      `  Run 'pnpm --filter @agent-platform/cli build' first, then re-run this command via 'agent gateway install'.`,
    );
    process.exit(1);
  }

  const entrypointArgs = ['gateway', 'start', '--foreground'];
  if (options.port) entrypointArgs.push('--port', options.port);
  if (options.authToken) entrypointArgs.push('--auth-token', options.authToken);

  const installOpts: ServiceInstallOptions = {
    label,
    nodeBinary: process.execPath,
    entrypoint: entry,
    entrypointArgs,
    env: buildServiceEnv(paths, options),
    stdoutLog: paths.stdoutLog,
    stderrLog: paths.stderrLog,
    workingDir: paths.stateDir,
  };

  console.log(`[gateway] installing service '${label}' (${adapter.platform})...`);
  await adapter.install(installOpts);
  console.log(`[gateway] installed.`);
  console.log(`  stdout ${paths.stdoutLog}`);
  console.log(`  stderr ${paths.stderrLog}`);

  if (options.start) {
    console.log(`[gateway] starting...`);
    await adapter.start(label);
    console.log(`[gateway] started.`);
  }
}

export async function gatewayUninstallCommand(options: { label?: string }): Promise<void> {
  const adapter = resolveServiceAdapter();
  const label = options.label ?? defaultServiceLabel();
  console.log(`[gateway] uninstalling service '${label}'...`);
  await adapter.uninstall(label);
  console.log(`[gateway] uninstalled.`);
}

export async function gatewayRestartCommand(options: { label?: string }): Promise<void> {
  const adapter = resolveServiceAdapter();
  const label = options.label ?? defaultServiceLabel();
  console.log(`[gateway] restarting service '${label}'...`);
  await adapter.restart(label);
  console.log(`[gateway] restarted.`);
}

/**
 * Build the env block injected into the supervised process. We forward the
 * model provider selection + API keys so the service doesn't have to rely on
 * interactive shell env.
 */
function buildServiceEnv(
  paths: GatewayPaths,
  options: { port?: string; authToken?: string },
): Record<string, string> {
  const env: Record<string, string> = {
    NODE_ENV: 'production',
    AGENT_STATE_DIR: paths.stateDir,
  };
  const forwards: string[] = [
    'PATH',
    'AGENT_MODEL',
    'AGENT_PROVIDER',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'ANTHROPIC_API_KEY',
  ];
  for (const key of forwards) {
    const v = process.env[key];
    if (v) env[key] = v;
  }
  if (options.port) env['AGENT_GATEWAY_PORT'] = options.port;
  if (options.authToken) env['AGENT_GATEWAY_TOKEN'] = options.authToken;

  // Sanity for Windows: schtasks wrappers aren't a shell, so we also set a
  // HOME/USERPROFILE pass-through so dotenv-style lookups work.
  if (currentPlatform() === 'windows' && process.env['USERPROFILE']) {
    env['USERPROFILE'] = process.env['USERPROFILE'];
  }
  return env;
}

async function handleDetach(paths: GatewayPaths, options: GatewayStartOptions): Promise<void> {
  const passthrough = ['gateway', 'start', '--foreground'];
  if (options.port) passthrough.push('--port', options.port);
  if (options.host) passthrough.push('--host', options.host);
  if (options.authToken) passthrough.push('--auth-token', options.authToken);

  const cmd = defaultDaemonCommand(passthrough);

  console.log(`[gateway] spawning detached daemon...`);
  try {
    const result = await detachGateway({
      paths,
      command: cmd,
      env: { AGENT_GATEWAY_DETACHED: '1' },
    });
    console.log(`[gateway] running in background`);
    console.log(`  pid    ${result.pid}`);
    console.log(`  port   ${result.port}`);
    console.log(`  stdout ${paths.stdoutLog}`);
    console.log(`  stderr ${paths.stderrLog}`);
    console.log(`\nUse 'agent gateway stop' to shut it down.`);
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      console.error(`[gateway] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

export async function gatewayHealthCommand(options: GatewayConnectOptions): Promise<void> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? process.env['AGENT_GATEWAY_PORT'] ?? '18790';
  const res = await rpcCall(host, Number(port), options.authToken, 'gateway.health', {}, 5000);
  console.log(JSON.stringify(res, null, 2));
}

export async function gatewayStopCommand(options: GatewayConnectOptions): Promise<void> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? process.env['AGENT_GATEWAY_PORT'] ?? '18790';
  try {
    await rpcCall(host, Number(port), options.authToken, 'gateway.shutdown', {}, 10000);
    console.log('[gateway] shutdown requested');
  } catch (err) {
    console.error(`[gateway] stop failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function ensureStateDirs(paths: GatewayPaths): Promise<void> {
  const dirs = [
    paths.stateDir,
    paths.logsDir,
    paths.runDir,
    `${paths.stateDir}/state`,
    paths.palaceRoot,
    `${paths.stateDir}/ego`,
    join(paths.stateDir, 'workspace'),
    join(paths.stateDir, 'skills'),
  ];
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Build the `DefaultToolsConfig` for this gateway process. TUI / chat channels
 * need at least `fs.read` to answer "summarize this file" style prompts; env
 * vars let owner override the roots without editing ego.json.
 *
 *   AGENT_FS_READ_ROOTS   — PATH-separated read roots (default: stateDir + cwd)
 *   AGENT_FS_WRITE_ROOTS  — PATH-separated write roots (default: stateDir/workspace)
 *   AGENT_WEB_DOMAINS     — comma/semicolon/path-separated host allowlist
 *                           (default: undefined, i.e. web.fetch is OFF)
 */
function resolveDefaultToolsConfig(stateDir: string): DefaultToolsConfig {
  const fsReadEnv = splitRoots(process.env['AGENT_FS_READ_ROOTS']);
  const fsWriteEnv = splitRoots(process.env['AGENT_FS_WRITE_ROOTS']);
  const webEnv = splitRoots(process.env['AGENT_WEB_DOMAINS']);

  const cfg: DefaultToolsConfig = {
    fsRead: fsReadEnv ?? [stateDir, process.cwd()],
    fsWrite: fsWriteEnv ?? [join(stateDir, 'workspace')],
  };
  if (webEnv) cfg.webFetch = webEnv;
  return cfg;
}

/**
 * Read the optional agent system-prompt file. Missing file is a silent
 * no-op (runner falls back to PromptBuilder's built-in default); other
 * IO errors surface so the operator notices permission / encoding issues.
 */
async function loadOptionalSystemPrompt(path: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path, 'utf-8');
    const trimmed = raw.trim();
    return trimmed.length > 0 ? raw : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Resolve the directory containing the built webapp SPA.
 * Precedence: explicit `--webapp-dir` → `AGENT_WEBAPP_DIR` env var → auto-detect
 * by walking up from this module to find `packages/webapp/dist/index.html`.
 * Returns `undefined` when no dist is found; the gateway then skips `/ui/*`
 * (browsers can still reach `/device/*` via a reverse proxy such as Vite dev).
 */
function resolveWebappDir(explicit: string | undefined): string | undefined {
  if (explicit) {
    if (!existsSync(join(explicit, 'index.html'))) {
      console.error(
        `[gateway] --webapp-dir '${explicit}' has no index.html — refusing to serve /ui/*.`,
      );
      process.exit(1);
    }
    return explicit;
  }

  const envDir = process.env['AGENT_WEBAPP_DIR'];
  if (envDir) {
    if (!existsSync(join(envDir, 'index.html'))) {
      console.error(
        `[gateway] AGENT_WEBAPP_DIR='${envDir}' has no index.html — refusing to serve /ui/*.`,
      );
      process.exit(1);
    }
    return envDir;
  }

  // Walk up from this module until we hit `packages/webapp/dist/index.html`.
  // Covers both dev (tsx loads packages/cli/src/commands/gateway.ts) and
  // built (packages/cli/dist/commands/gateway.js) layouts.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'packages', 'webapp', 'dist', 'index.html');
    if (existsSync(candidate)) return dirname(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function splitRoots(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  // Support both POSIX (":"), Windows (";") and comma to be forgiving.
  return trimmed
    .split(/[;,:]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function rpcCall(
  host: string,
  port: number,
  authToken: string | undefined,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const token = authToken ?? process.env['AGENT_GATEWAY_TOKEN'] ?? 'dev-token';
  const ws = new WebSocket(`ws://${host}:${port}/rpc`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const id = `cli-${Date.now()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`rpc ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
    ws.on('message', (data) => {
      try {
        const frame = JSON.parse(data.toString('utf-8')) as {
          id?: unknown;
          result?: unknown;
          error?: { code: number; message: string };
        };
        if (frame.id !== id) return; // ignore notifications
        clearTimeout(timer);
        if (frame.error) {
          reject(new Error(`${frame.error.message} (code ${frame.error.code})`));
        } else {
          resolve(frame.result);
        }
        ws.close();
      } catch (err) {
        clearTimeout(timer);
        reject(err as Error);
        ws.close();
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Produce an "EGO enabled out of the box" config. Used when the user has not
 * written `~/.agent/ego/ego.json` themselves. EGO's deep path runs on every
 * non-fast-path message and requires `OPENAI_API_KEY` in the environment —
 * startup hard-fails if that env var is missing (see egoLlm wiring in
 * gatewayStartCommand). Users who want EGO disabled must author an ego.json
 * with `"state": "off"`; users who want Anthropic should author one with
 * `provider: "anthropic"` + `apiKey: "${ANTHROPIC_API_KEY}"`.
 */
function defaultActiveEgoConfig(paths: GatewayPaths): EgoFullConfig {
  const egoDir = `${paths.stateDir}/ego`;
  return {
    schemaVersion: '1.1.0',
    state: 'active',
    fallbackOnError: true,
    maxDecisionTimeMs: 5000,
    llm: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: '${OPENAI_API_KEY}',
      temperature: 0.1,
      maxTokens: 1024,
      topP: 0.9,
    },
    thresholds: {
      minConfidenceToAct: 0.6,
      minRelevanceToEnrich: 0.3,
      minRelevanceToRedirect: 0.5,
      minRelevanceToDirectRespond: 0.8,
      maxCostUsdPerDecision: 0.05,
      maxCostUsdPerDay: 5.0,
    },
    fastPath: {
      passthroughIntents: ['greeting', 'command', 'reaction'],
      passthroughPatterns: ['^/(reset|status)'],
      maxComplexityForPassthrough: 'simple',
      targetRatio: 0.75,
      measurementWindowDays: 7,
    },
    prompts: {
      systemPromptFile: `${egoDir}/system.md`,
      responseFormat: 'json',
    },
    goals: {
      enabled: true,
      maxActiveGoals: 10,
      autoDetectCompletion: true,
      storePath: paths.egoGoalsStore,
    },
    memory: {
      searchOnCognize: true,
      maxSearchResults: 5,
      searchTimeoutMs: 2000,
      onTimeout: 'empty_result',
    },
    persona: {
      enabled: true,
      storePath: paths.egoPersonaStore,
      snapshot: {
        maxTokens: 250,
        topRelevantBehaviors: 3,
        topRelevantExpertise: 3,
        includeRelationshipContext: true,
      },
    },
    errorHandling: {
      onLlmInvalidJson: 'passthrough',
      onLlmTimeout: 'passthrough',
      onLlmOutOfRange: 'passthrough',
      onConsecutiveFailures: {
        threshold: 3,
        action: 'disable_llm_path',
        cooldownMinutes: 10,
      },
    },
    audit: {
      enabled: true,
      logLevel: 'decisions',
      storePath: paths.egoAuditDb,
      retentionDays: 90,
    },
  };
}
