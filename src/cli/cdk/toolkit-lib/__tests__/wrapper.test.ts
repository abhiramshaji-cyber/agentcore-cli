import { CdkToolkitWrapper } from '../wrapper.js';
import { StackSelectionStrategy } from '@aws-cdk/toolkit-lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const deploySpy = vi.fn().mockResolvedValue(undefined);

vi.mock('@aws-cdk/toolkit-lib', async () => {
  const actual = await vi.importActual<typeof import('@aws-cdk/toolkit-lib')>('@aws-cdk/toolkit-lib');
  return {
    ...actual,
    Toolkit: class {
      fromCdkApp = vi.fn().mockResolvedValue({});
      deploy = deploySpy;
    },
  };
});

describe('CdkToolkitWrapper.deploy', () => {
  beforeEach(() => deploySpy.mockClear());

  it.each([
    { express: undefined, expected: true },
    { express: false, expected: false },
  ])('deploys with express=$expected when express is $express', async ({ express, expected }) => {
    const wrapper = new CdkToolkitWrapper({ projectDir: '/tmp/agentcore-cdk', region: 'us-west-2' });
    await wrapper.initialize();
    const stacks = { strategy: StackSelectionStrategy.PATTERN_MUST_MATCH, patterns: ['AgentCore-myapp-default'] };

    await wrapper.deploy({ stacks, express });

    expect(deploySpy).toHaveBeenCalledWith(expect.anything(), { stacks, express: expected });
  });
});
