import type { EgoState } from '../types/ego.js';

const ORDER: readonly EgoState[] = ['off', 'passive', 'active'] as const;

export function isOperational(state: EgoState): boolean {
  return state !== 'off';
}

export function isIntervening(state: EgoState): boolean {
  return state === 'active';
}

export function canTransition(_from: EgoState, _to: EgoState): boolean {
  // ADR-006: all transitions are legal; documented that in-flight messages
  // complete under the source state and the next message observes the target.
  return true;
}

export function downgradeState(current: EgoState): EgoState {
  const idx = ORDER.indexOf(current);
  if (idx <= 0) return 'off';
  return ORDER[idx - 1] as EgoState;
}

export function upgradeState(current: EgoState): EgoState {
  const idx = ORDER.indexOf(current);
  if (idx < 0 || idx >= ORDER.length - 1) return current;
  return ORDER[idx + 1] as EgoState;
}

export function compareStates(a: EgoState, b: EgoState): number {
  return ORDER.indexOf(a) - ORDER.indexOf(b);
}
