import { describe, it, expect } from 'vitest';
import {
  isOperational,
  isIntervening,
  canTransition,
  downgradeState,
  upgradeState,
  compareStates,
} from '../src/adr/state.js';

describe('ADR-006 EgoState helpers', () => {
  it('isOperational is false only for off', () => {
    expect(isOperational('off')).toBe(false);
    expect(isOperational('passive')).toBe(true);
    expect(isOperational('active')).toBe(true);
  });

  it('isIntervening is true only for active', () => {
    expect(isIntervening('off')).toBe(false);
    expect(isIntervening('passive')).toBe(false);
    expect(isIntervening('active')).toBe(true);
  });

  it('downgradeState walks active → passive → off', () => {
    expect(downgradeState('active')).toBe('passive');
    expect(downgradeState('passive')).toBe('off');
    expect(downgradeState('off')).toBe('off');
  });

  it('upgradeState walks off → passive → active', () => {
    expect(upgradeState('off')).toBe('passive');
    expect(upgradeState('passive')).toBe('active');
    expect(upgradeState('active')).toBe('active');
  });

  it('compareStates orders off < passive < active', () => {
    expect(compareStates('off', 'passive')).toBeLessThan(0);
    expect(compareStates('passive', 'active')).toBeLessThan(0);
    expect(compareStates('active', 'off')).toBeGreaterThan(0);
    expect(compareStates('active', 'active')).toBe(0);
  });

  it('canTransition permits any transition (source state completes in-flight)', () => {
    expect(canTransition('off', 'active')).toBe(true);
    expect(canTransition('active', 'off')).toBe(true);
    expect(canTransition('passive', 'passive')).toBe(true);
  });
});
