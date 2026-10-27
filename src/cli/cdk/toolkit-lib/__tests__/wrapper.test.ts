import { ConflictError } from '../../../../lib';
import { silentIoHost } from '../types.js';
import { CdkToolkitWrapper } from '../wrapper.js';
import { type IIoHost, StackSelectionStrategy } from '@aws-cdk/toolkit-lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const deploySpy = vi.fn();
let toolkitIoHost: IIoHost | undefined;

vi.mock('@aws-cdk/toolkit-lib', async () => {
  const actual = await vi.importActual<typeof import('@aws-cdk/toolkit-lib')>('@aws-cdk/toolkit-lib');
  return {
    ...actual,
    Toolkit: class {
      fromCdkApp = vi.fn().mockResolvedValue({});
      deploy = deploySpy;
      constructor(props: { ioHost?: IIoHost }) {
        toolkitIoHost = props.ioHost;
      }
    },
  };
});

const stacks = { strategy: StackSelectionStrategy.PATTERN_MUST_MATCH, patterns: ['AgentCore-myapp-default'] };

async function initializedWrapper() {
  const wrapper = new CdkToolkitWrapper({
    projectDir: '/tmp/agentcore-cdk',
    region: 'us-west-2',
    ioHost: silentIoHost,
  });
  await wrapper.initialize();
  return wrapper;
}

describe('CdkToolkitWrapper.deploy', () => {
  beforeEach(() => {
    deploySpy.mockReset();
    deploySpy.mockResolvedValue({ stacks: [] });
  });

  it.each([
    { express: undefined, expected: true },
    { express: false, expected: false },
  ])('deploys with express=$expected when express is $express', async ({ express, expected }) => {
    const wrapper = await initializedWrapper();

    await expect(wrapper.deploy({ stacks, express })).resolves.toEqual({ stabilizationWarning: undefined });

    expect(deploySpy).toHaveBeenCalledWith(expect.anything(), { stacks, express: expected });
  });

  it('returns the Express mode stabilization warning emitted during deploy', async () => {
    const wrapper = await initializedWrapper();
    deploySpy.mockImplementation(async () => {
      await toolkitIoHost!.notify({
        time: new Date(),
        level: 'warn',
        action: 'deploy',
        code: 'CDK_TOOLKIT_W5902',
        message: 'ApplicationAgentRuntime is still stabilizing',
        data: undefined,
      });
      return { stacks: [] };
    });

    await expect(wrapper.deploy({ stacks })).resolves.toEqual({
      stabilizationWarning: 'ApplicationAgentRuntime is still stabilizing',
    });
  });

  it('replaces the toolkit-lib ExpressStackFailPaused advice with agentcore guidance', async () => {
    const wrapper = await initializedWrapper();
    const toolkitError = new Error('Run `cdk deploy --express --no-rollback` to deploy this change without rollback.');
    toolkitError.name = 'ExpressStackFailPaused';
    deploySpy.mockRejectedValue(toolkitError);

    const error = await wrapper.deploy({ stacks, express: false }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as Error).message).toContain('run `agentcore deploy` without --no-express');
    expect((error as Error).message).not.toContain('cdk deploy');
  });
});
