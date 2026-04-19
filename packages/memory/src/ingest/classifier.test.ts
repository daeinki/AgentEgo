import { describe, it, expect } from 'vitest';
import { classifyContent } from './classifier.js';

describe('classifyContent', () => {
  it('routes deploy/PR talk to work/projects', () => {
    const m = classifyContent('오늘 배포 PR 올렸음. 프로덕션에 나감.');
    expect(m.wing).toBe('work');
    expect(m.subcategory).toBe('projects');
  });

  it('routes code/technical talk to knowledge/technical', () => {
    const m = classifyContent('TypeScript에서 interface와 class 차이를 설명');
    expect(m.wing).toBe('knowledge');
    expect(m.subcategory).toBe('technical');
  });

  it('routes corrections to interactions/corrections', () => {
    const m = classifyContent('아니야, 이건 틀렸어. 다시 해줘.');
    expect(m.wing).toBe('interactions');
    expect(m.subcategory).toBe('corrections');
  });

  it('routes positive feedback to interactions/feedback', () => {
    const m = classifyContent('정말 좋아 최고야 고마워');
    expect(m.wing).toBe('interactions');
    expect(m.subcategory).toBe('feedback');
  });

  it('routes preference talk to personal/preferences', () => {
    const m = classifyContent('나는 아침에 캐주얼한 톤을 선호해');
    expect(m.wing).toBe('personal');
    expect(m.subcategory).toBe('preferences');
  });

  it('falls back to knowledge with low confidence when no rule matches', () => {
    const m = classifyContent('오늘 날씨가 참 맑네요.');
    expect(m.wing).toBe('knowledge');
    expect(m.confidence).toBeLessThan(0.5);
  });
});
