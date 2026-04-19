import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { Persona, STYLE_PRESETS } from '../src/schema/persona.js';

const FIXTURE = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/persona.json'), 'utf-8'),
);

describe('Persona schema against repository fixture (persona.json)', () => {
  it('accepts the canonical persona.json fixture', () => {
    const isValid = Value.Check(Persona, FIXTURE);
    if (!isValid) {
      const errors = [...Value.Errors(Persona, FIXTURE)].map((e) => ({
        path: e.path,
        message: e.message,
      }));
      throw new Error(`persona.json failed Persona: ${JSON.stringify(errors, null, 2)}`);
    }
    expect(isValid).toBe(true);
  });

  it('fixture starts with empty learned arrays (§4.7)', () => {
    expect(FIXTURE.learnedBehaviors).toHaveLength(0);
    expect(FIXTURE.domainExpertise).toHaveLength(0);
    expect(FIXTURE.evolutionLog).toHaveLength(0);
    expect(FIXTURE.totalInteractions).toBe(0);
    expect(FIXTURE.evolutionCount).toBe(0);
  });

  it('fixture declares a personaId with the `prs-` prefix', () => {
    expect(FIXTURE.personaId).toMatch(/^prs-/);
  });

  it('rejects ratio values outside [0, 1]', () => {
    const bad = structuredClone(FIXTURE);
    bad.communicationStyle.formality = 1.2;
    expect(Value.Check(Persona, bad)).toBe(false);
  });

  it('survives JSON round-trip', () => {
    const roundTripped = JSON.parse(JSON.stringify(FIXTURE));
    expect(Value.Check(Persona, roundTripped)).toBe(true);
  });
});

describe('Style presets', () => {
  it('exposes exactly four documented presets', () => {
    const names = Object.keys(STYLE_PRESETS).sort();
    expect(names).toEqual(
      ['analytical-precise', 'casual-friendly', 'creative-expressive', 'professional-concise'].sort(),
    );
  });

  it('all preset communication styles use ratio values in [0, 1]', () => {
    for (const [name, preset] of Object.entries(STYLE_PRESETS)) {
      const style = (preset as { communicationStyle?: Record<string, number> }).communicationStyle;
      if (!style) continue;
      for (const [field, val] of Object.entries(style)) {
        expect(val, `${name}.${field}`).toBeGreaterThanOrEqual(0);
        expect(val, `${name}.${field}`).toBeLessThanOrEqual(1);
      }
    }
  });
});
