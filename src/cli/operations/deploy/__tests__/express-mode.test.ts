import type { AgentCoreProjectSpec } from '../../../../schema';
import { resolveExpressMode } from '../express-mode.js';
import { describe, expect, it } from 'vitest';

describe('resolveExpressMode', () => {
  const withEval = { onlineEvalConfigs: [{ name: 'QualityEval' }] } as unknown as Partial<AgentCoreProjectSpec>;

  it.each([
    { spec: {}, express: undefined, expected: true },
    { spec: {}, express: false, expected: false },
    { spec: withEval, express: undefined, expected: false },
    { spec: withEval, express: true, expected: false },
  ])('returns $expected for express=$express', ({ spec, express, expected }) => {
    expect(resolveExpressMode(spec, express)).toBe(expected);
  });
});
