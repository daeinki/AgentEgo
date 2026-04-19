import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { EgoFullConfig, EgoConfig, EgoState } from '../src/types/ego.js';

const FIXTURE = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/ego.json'), 'utf-8'),
);

describe('EgoState schema (ADR-006)', () => {
  it('accepts the three documented states', () => {
    for (const s of ['off', 'passive', 'active']) {
      expect(Value.Check(EgoState, s)).toBe(true);
    }
  });

  it('rejects unknown state values', () => {
    expect(Value.Check(EgoState, 'disabled')).toBe(false);
    expect(Value.Check(EgoState, true)).toBe(false);
    expect(Value.Check(EgoState, null)).toBe(false);
  });
});

describe('EgoConfig (minimal) schema', () => {
  it('accepts a valid minimal config', () => {
    const good: unknown = {
      schemaVersion: '1.1.0',
      state: 'passive',
      fallbackOnError: true,
      maxDecisionTimeMs: 3000,
    };
    expect(Value.Check(EgoConfig, good)).toBe(true);
  });

  it('rejects legacy shape with `enabled` + `mode` instead of `state`', () => {
    const legacy: unknown = {
      schemaVersion: '1.1.0',
      enabled: true,
      mode: 'active',
      fallbackOnError: true,
      maxDecisionTimeMs: 3000,
    };
    expect(Value.Check(EgoConfig, legacy)).toBe(false);
  });
});

describe('EgoFullConfig against repository fixture (ego.json)', () => {
  it('accepts the canonical ego.json fixture', () => {
    const isValid = Value.Check(EgoFullConfig, FIXTURE);
    if (!isValid) {
      const errors = [...Value.Errors(EgoFullConfig, FIXTURE)].map((e) => ({
        path: e.path,
        message: e.message,
      }));
      throw new Error(`ego.json failed EgoFullConfig: ${JSON.stringify(errors, null, 2)}`);
    }
    expect(isValid).toBe(true);
  });

  it('fixture uses the new `state` field (not `enabled`/`mode`)', () => {
    expect(FIXTURE.state).toBeDefined();
    expect(['off', 'passive', 'active']).toContain(FIXTURE.state);
    expect(FIXTURE.enabled).toBeUndefined();
    expect(FIXTURE.mode).toBeUndefined();
  });

  it('fixture declares schemaVersion', () => {
    expect(FIXTURE.schemaVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('fixture declares the new guard-rail fields', () => {
    expect(FIXTURE.thresholds.maxCostUsdPerDay).toBeGreaterThan(0);
    expect(FIXTURE.fastPath.targetRatio).toBeGreaterThan(0);
    expect(FIXTURE.fastPath.measurementWindowDays).toBeGreaterThan(0);
    expect(FIXTURE.memory.onTimeout).toBeDefined();
    expect(FIXTURE.persona).toBeDefined();
    expect(FIXTURE.errorHandling).toBeDefined();
    expect(FIXTURE.errorHandling.onConsecutiveFailures.threshold).toBeGreaterThan(0);
  });
});

describe('EgoFullConfig survives JSON round-trip', () => {
  it('parses and revalidates unchanged', () => {
    const roundTripped = JSON.parse(JSON.stringify(FIXTURE));
    expect(Value.Check(EgoFullConfig, roundTripped)).toBe(true);
  });
});
