import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { EgoFullConfig, EgoState } from '@agent-platform/core';

interface EgoOptions {
  config?: string;
}

const DEFAULT_CONFIG_PATH = resolve(homedir(), '.agent', 'ego', 'ego.json');

const VALID_STATES: readonly EgoState[] = ['off', 'passive', 'active'] as const;

export async function egoCommand(action: string, options: EgoOptions): Promise<void> {
  const configPath = options.config ?? DEFAULT_CONFIG_PATH;

  switch (action) {
    case 'off':
    case 'passive':
    case 'active':
      await setEgoState(configPath, action);
      console.log(`EGO state: ${action}`);
      break;
    case 'on':
      // Backward-compat alias: `ego on` → `ego active`
      await setEgoState(configPath, 'active');
      console.log('EGO state: active (alias for `on`)');
      break;
    case 'status':
      await showEgoStatus(configPath);
      break;
    default:
      console.error(
        `Unknown ego action: ${action}. Use: ${[...VALID_STATES, 'on', 'status'].join(' | ')}`,
      );
      process.exit(1);
  }
}

function defaultConfig(): EgoFullConfig {
  return {
    schemaVersion: '1.1.0',
    state: 'off',
    fallbackOnError: true,
    maxDecisionTimeMs: 3000,
    llm: null,
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
      passthroughPatterns: [
        '^/(reset|status|new|compact|help)',
        '^(hi|hello|hey|안녕|ㅎㅇ|감사|고마워|ㄱㅅ)',
      ],
      maxComplexityForPassthrough: 'simple',
      targetRatio: 0.75,
      measurementWindowDays: 7,
    },
    prompts: {
      systemPromptFile: '~/.agent/ego/system-prompt.md',
      responseFormat: 'json',
    },
    goals: {
      enabled: true,
      maxActiveGoals: 10,
      autoDetectCompletion: true,
      storePath: '~/.agent/ego/goals.json',
    },
    memory: {
      searchOnCognize: true,
      maxSearchResults: 5,
      searchTimeoutMs: 1500,
      onTimeout: 'empty_result',
    },
    persona: {
      enabled: true,
      storePath: '~/.agent/ego/persona.json',
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
        threshold: 5,
        action: 'disable_llm_path',
        cooldownMinutes: 15,
      },
    },
    audit: {
      enabled: true,
      logLevel: 'decisions',
      storePath: '~/.agent/ego/audit.db',
      retentionDays: 90,
    },
  };
}

async function setEgoState(configPath: string, state: EgoState): Promise<void> {
  let config: Record<string, unknown>;
  try {
    const raw = await readFile(configPath, 'utf-8');
    config = JSON.parse(raw);
  } catch {
    config = defaultConfig() as unknown as Record<string, unknown>;
  }

  // Strip legacy v0.2 keys if present, then set v0.3 state.
  delete config['enabled'];
  delete config['mode'];
  config['state'] = state;

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

async function showEgoStatus(configPath: string): Promise<void> {
  try {
    const raw = await readFile(configPath, 'utf-8');
    const config = JSON.parse(raw) as EgoFullConfig;
    console.log('=== EGO Status ===\n');
    console.log(`Config: ${configPath}`);
    console.log(`Schema version: ${config.schemaVersion ?? '(unversioned)'}`);
    console.log(`State: ${config.state}`);
    console.log(`Fallback on error: ${config.fallbackOnError}`);
    console.log(`Max decision time: ${config.maxDecisionTimeMs}ms`);

    if (config.llm) {
      console.log(`\nLLM: ${config.llm.provider}/${config.llm.model}`);
      if (config.llm.fallback) {
        console.log(
          `Fallback LLM: ${config.llm.fallback.provider}/${config.llm.fallback.model}`,
        );
      }
    } else {
      console.log('\nLLM: not configured (rule-based only)');
    }

    console.log(`\nFast path intents: ${config.fastPath.passthroughIntents.join(', ')}`);
    console.log(`Max passthrough complexity: ${config.fastPath.maxComplexityForPassthrough}`);
    console.log(`Target fast-path ratio: ${config.fastPath.targetRatio}`);
    console.log(`Daily cost cap: $${config.thresholds.maxCostUsdPerDay}`);
  } catch {
    console.log(`EGO config not found at ${configPath}`);
    console.log('Run "agent ego active" to create a default config.');
  }
}
