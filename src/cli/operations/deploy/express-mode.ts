import type { AgentCoreProjectSpec } from '../../../schema';

export const EXPRESS_FALLBACK_NOTICE =
  'Deploying without CloudFormation Express mode: online eval configs need the agent runtime log group, ' +
  'which only exists after the runtime finishes starting.';

/**
 * Express mode does not wait for resources to stabilize, so an online eval config can be created
 * before the runtime has created the log group it reads from. Projects with online eval configs
 * therefore always deploy in standard mode.
 */
export function resolveExpressMode(projectSpec: Partial<AgentCoreProjectSpec>, express = true): boolean {
  return express && (projectSpec.onlineEvalConfigs ?? []).length === 0;
}
