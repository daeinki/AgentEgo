import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { isOperational, isIntervening } from '@agent-platform/core';
import type { EgoFullConfig, EgoState } from '@agent-platform/core';

const DEFAULT_CONFIG_PATH = resolve(homedir(), '.agent', 'ego', 'ego.json');
const LEGACY_CONFIG_PATH = resolve(homedir(), '.agent', 'ego.json');

/**
 * Load EGO configuration from ego.json.
 * Returns null if config file not found.
 *
 * `EGO_FORCE_DEEP=1` 환경변수가 설정되어 있으면 로드된 config 의
 * `fastPath.enabled` 를 `false` 로 강제 설정한다 (ego.json 수정 없이 deep path 실험).
 */
export async function loadEgoConfig(configPath?: string): Promise<EgoFullConfig | null> {
  const candidates = configPath ? [configPath] : [DEFAULT_CONFIG_PATH, LEGACY_CONFIG_PATH];

  for (const path of candidates) {
    try {
      const raw = await readFile(path, 'utf-8');
      const config = JSON.parse(raw) as EgoFullConfig;
      return applyEnvOverrides(config);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
  return null;
}

/**
 * Apply environment-variable overrides to a loaded EGO config.
 * Currently supports:
 *   - EGO_FORCE_DEEP=1 → fastPath.enabled = false (모든 신호를 deep path 로 강제)
 */
export function applyEnvOverrides(config: EgoFullConfig): EgoFullConfig {
  if (process.env['EGO_FORCE_DEEP'] === '1') {
    return {
      ...config,
      fastPath: { ...config.fastPath, enabled: false },
    };
  }
  return config;
}

/**
 * Whether EGO is in an operational state (not `off`).
 * Backward-compatible name for pre-v0.3 callers.
 */
export function isEgoEnabled(config: EgoFullConfig | null): boolean {
  if (!config) return false;
  return isOperational(config.state);
}

/**
 * Whether EGO should actually intervene (`state === 'active'`).
 */
export function isEgoActive(config: EgoFullConfig | null): boolean {
  if (!config) return false;
  return isIntervening(config.state);
}

/**
 * Current EGO state (`off` if no config loaded).
 */
export function getEgoState(config: EgoFullConfig | null): EgoState {
  return config?.state ?? 'off';
}
