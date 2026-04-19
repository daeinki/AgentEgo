import { describe, it, expect } from 'vitest';
import {
  classifyComplexity,
  classifyText,
  countClauses,
  countSequentialConnectors,
  estimateTokenCount,
} from '../src/normalize/complexity.js';

describe('classifyComplexity (ego-design §4 S2 rule table)', () => {
  it('trivial: short, single clause', () => {
    expect(classifyComplexity({ tokenCount: 5, clauseCount: 1, sequentialConnectors: 0 })).toBe(
      'trivial',
    );
  });

  it('simple: up to 30 tokens and 2 clauses', () => {
    expect(classifyComplexity({ tokenCount: 25, clauseCount: 2, sequentialConnectors: 0 })).toBe(
      'simple',
    );
  });

  it('moderate: up to 80 tokens, 2-4 clauses', () => {
    expect(classifyComplexity({ tokenCount: 70, clauseCount: 3, sequentialConnectors: 0 })).toBe(
      'moderate',
    );
  });

  it('complex: up to 200 tokens', () => {
    expect(classifyComplexity({ tokenCount: 150, clauseCount: 5, sequentialConnectors: 0 })).toBe(
      'complex',
    );
  });

  it('multi_step: >200 tokens escalates', () => {
    expect(classifyComplexity({ tokenCount: 250, clauseCount: 3, sequentialConnectors: 0 })).toBe(
      'multi_step',
    );
  });

  it('multi_step: 3+ sequential connectors escalates regardless of length', () => {
    expect(classifyComplexity({ tokenCount: 20, clauseCount: 1, sequentialConnectors: 3 })).toBe(
      'multi_step',
    );
  });
});

describe('countSequentialConnectors', () => {
  it('counts Korean and English connectors', () => {
    const n = countSequentialConnectors('먼저 X 하고 그 다음 Y 하고 finally Z');
    expect(n).toBeGreaterThanOrEqual(2);
  });
});

describe('countClauses', () => {
  it('always returns at least 1', () => {
    expect(countClauses('hi')).toBe(1);
  });

  it('splits on punctuation', () => {
    expect(countClauses('one, two. three!')).toBe(3);
  });
});

describe('classifyText', () => {
  it('returns trivial for a single-word greeting', () => {
    expect(classifyText('안녕')).toBe('trivial');
  });

  it('escalates to multi_step for a long plan', () => {
    const plan =
      'First set up the repo, then configure the build, next add tests, and finally ship the artifact. ' +
      'The repo should have a README, a package.json, and several TypeScript files. Tests should cover ' +
      'both the happy path and edge cases, including timeout handling and error propagation. Shipping ' +
      'means tagging a release and uploading the artifact to the registry.';
    expect(classifyText(plan)).toBe('multi_step');
  });
});

describe('estimateTokenCount', () => {
  it('scales with English words', () => {
    expect(estimateTokenCount('one two three')).toBeGreaterThanOrEqual(3);
  });

  it('counts CJK characters', () => {
    expect(estimateTokenCount('안녕하세요')).toBeGreaterThanOrEqual(2);
  });
});
