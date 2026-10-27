/**
 * E2E tests for the archive command.
 *
 * Flow: create project → deploy → invoke → run batch-eval → run recommendation →
 *       archive batch-eval (verify service delete + local .cli cleared) →
 *       archive recommendation (verify service delete + local .cli cleared)
 *
 * Prerequisites:
 *   - AWS credentials
 *   - npm, git, uv installed
 */
import { parseJsonOutput, retry } from '../src/test-utils/index.js';
import {
  baseCanRun,
  hasAws,
  installCdkTarball,
  runAgentCoreCLI,
  teardownE2EProject,
  writeAwsTargets,
} from './e2e-helper.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const canRun = baseCanRun && hasAws;
const jobWaitTimeoutMs = 480000;
const jobPollIntervalMs = 10000;

describe.sequential('e2e: archive command lifecycle', () => {
  let testDir: string;
  let projectPath: string;
  const agentName = `E2eArch${String(Date.now()).slice(-8)}`;

  // IDs captured from run steps and used in archive steps
  let batchEvaluationId: string;
  let recommendationId: string;
  let batchEvaluationReady = false;
  let batchEvaluationArchived = false;
  let recommendationArchived = false;

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-archive-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    const result = await runAgentCoreCLI(
      [
        'create',
        '--name',
        agentName,
        '--language',
        'Python',
        '--framework',
        'Strands',
        '--model-provider',
        'Bedrock',
        '--memory',
        'none',
        '--json',
      ],
      testDir
    );
    expect(result.exitCode, `Create failed: ${result.stderr}`).toBe(0);
    projectPath = (parseJsonOutput(result.stdout) as { projectPath: string }).projectPath;

    await writeAwsTargets(projectPath);
    installCdkTarball(projectPath);
  }, 300000);

  afterAll(async () => {
    if (projectPath && hasAws) {
      await teardownE2EProject(projectPath, agentName, 'Bedrock');
    }
    if (testDir) await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
  }, 600000);

  const run = (args: string[]) => runAgentCoreCLI(args, projectPath);

  const waitForJob = async (type: 'batch-evaluation' | 'recommendation', id: string, terminalStatuses: string[]) => {
    const deadline = Date.now() + jobWaitTimeoutMs;
    let lastStatus = 'unknown';
    let lastError: string | undefined;
    let resultsFetched: boolean | undefined;

    while (Date.now() < deadline) {
      const result = await run(['view', type, id, '--json']);
      if (result.exitCode !== 0) {
        throw new Error(`view ${type} ${id} failed: ${result.stderr}\n${result.stdout}`);
      }

      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      lastStatus = typeof json.status === 'string' ? json.status : 'unknown';
      lastError = typeof json.error === 'string' ? json.error : undefined;
      resultsFetched = typeof json.resultsFetched === 'boolean' ? json.resultsFetched : undefined;
      if (lastError) {
        throw new Error(`${type} ${id} refresh failed: ${lastError} (status: ${lastStatus})`);
      }
      if (terminalStatuses.includes(lastStatus)) {
        return lastStatus;
      }

      await delay(Math.min(jobPollIntervalMs, Math.max(0, deadline - Date.now())));
    }

    throw new Error(
      `${type} ${id} did not finish within ${jobWaitTimeoutMs}ms; last status: ${lastStatus}, resultsFetched: ${resultsFetched ?? 'unknown'}, error: ${lastError ?? 'none'}`
    );
  };

  // ════════════════════════════════════════════════════════════════════════
  // Setup — deploy and generate traces
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'deploys the agent',
    async () => {
      const result = await run(['deploy', '--yes', '--json']);
      if (result.exitCode !== 0) {
        console.log('Deploy stdout:', result.stdout);
        console.log('Deploy stderr:', result.stderr);
      }
      expect(result.exitCode, 'Deploy failed').toBe(0);
      const json = parseJsonOutput(result.stdout) as { success: boolean };
      expect(json.success).toBe(true);
    },
    600000
  );

  it.skipIf(!canRun)(
    'invokes the deployed agent to generate traces',
    async () => {
      await retry(
        async () => {
          const result = await run(['invoke', '--prompt', 'Say hello', '--runtime', agentName, '--json']);
          expect(result.exitCode, `Invoke failed: ${result.stderr}`).toBe(0);
          const json = parseJsonOutput(result.stdout) as { success: boolean };
          expect(json.success).toBe(true);
        },
        3,
        15000
      );
    },
    180000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Batch evaluation — run and capture ID
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'waits for batch evaluation to finish and captures the ID',
    async () => {
      await retry(
        async () => {
          const result = await run([
            'run',
            'batch-evaluation',
            '--runtime',
            agentName,
            '--evaluator',
            'Builtin.Faithfulness',
            '--lookback-days',
            '1',
            '--json',
          ]);
          expect(result.exitCode, `batch-evaluation failed (stdout: ${result.stdout}, stderr: ${result.stderr})`).toBe(
            0
          );
          const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
          expect(json).toHaveProperty('success', true);
          expect(json.id).toBeTruthy();
          batchEvaluationId = json.id as string;
        },
        6,
        15000
      );

      const status = await waitForJob('batch-evaluation', batchEvaluationId, [
        'COMPLETED',
        'COMPLETED_WITH_ERRORS',
        'FAILED',
        'STOPPED',
        'CANCELLED',
      ]);
      expect(['COMPLETED', 'COMPLETED_WITH_ERRORS', 'STOPPED']).toContain(status);
      batchEvaluationReady = true;
    },
    600000
  );

  it.skipIf(!canRun)(
    'local .cli/batch-eval-results contains the run record',
    ctx => {
      if (!batchEvaluationId) ctx.skip();
      const filePath = join(
        projectPath,
        'agentcore',
        '.cli',
        'jobs',
        'batch-eval-results',
        `${batchEvaluationId}.json`
      );
      expect(existsSync(filePath), `Expected local record at ${filePath}`).toBe(true);
    },
    30000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Recommendation — run and capture ID
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'runs a recommendation and captures the ID',
    async () => {
      await retry(
        async () => {
          const result = await run([
            'run',
            'recommendation',
            '--runtime',
            agentName,
            '--evaluator',
            'Builtin.Faithfulness',
            '--inline',
            'You are a helpful assistant for testing.',
            '--lookback',
            '1',
            '--json',
          ]);
          expect(result.exitCode, `recommendation failed (stdout: ${result.stdout}, stderr: ${result.stderr})`).toBe(0);
          const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
          expect(json).toHaveProperty('success', true);
          expect(json.id).toBeTruthy();
          recommendationId = json.id as string;
        },
        6,
        30000
      );
    },
    600000
  );

  it.skipIf(!canRun)(
    'local .cli/recommendations contains the run record',
    () => {
      expect(recommendationId, 'recommendationId should have been captured').toBeTruthy();
      const filePath = join(projectPath, 'agentcore', '.cli', 'jobs', 'recommendations', `${recommendationId}.json`);
      expect(existsSync(filePath), `Expected local record at ${filePath}`).toBe(true);
    },
    30000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Archive batch evaluation
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'archive batch-evaluation fails without --id flag',
    async () => {
      const result = await run(['archive', 'batch-evaluation']);
      expect(result.exitCode).not.toBe(0);
    },
    30000
  );

  it.skipIf(!canRun)(
    'archives the batch evaluation with --json flag',
    async ctx => {
      if (!batchEvaluationReady) ctx.skip();

      const result = await run(['archive', 'batch-evaluation', '--id', batchEvaluationId, '--json']);
      expect(result.exitCode, `archive batch-evaluation failed: ${result.stderr}\n${result.stdout}`).toBe(0);

      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json).toHaveProperty('success', true);
      expect(json.id).toBe(batchEvaluationId);
      batchEvaluationArchived = true;
    },
    120000
  );

  it.skipIf(!canRun)(
    'local .cli/batch-eval-results no longer contains the archived record',
    ctx => {
      if (!batchEvaluationArchived) ctx.skip();
      const filePath = join(
        projectPath,
        'agentcore',
        '.cli',
        'jobs',
        'batch-eval-results',
        `${batchEvaluationId}.json`
      );
      expect(existsSync(filePath), `Local record should have been deleted from ${filePath}`).toBe(false);
    },
    30000
  );

  it.skipIf(!canRun)(
    'evals history does not surface the archived batch evaluation ID',
    async ctx => {
      if (!batchEvaluationArchived) ctx.skip();
      // evals history lists on-demand (run eval) records — batch evals are stored separately.
      // Verify: the command succeeds and contains no entry matching our batch evaluation ID.
      const result = await run(['evals', 'history', '--json']);
      expect(result.exitCode, `evals history failed: ${result.stderr}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as { runs?: { agent: string }[] };
      const output = JSON.stringify(json.runs ?? []);
      expect(output).not.toContain(batchEvaluationId);
    },
    60000
  );

  it.skipIf(!canRun)(
    'archiving the same batch evaluation again returns success false (already deleted)',
    async ctx => {
      if (!batchEvaluationArchived) ctx.skip();
      const result = await run(['archive', 'batch-evaluation', '--id', batchEvaluationId, '--json']);
      // Service should return an error (resource not found / already deleted)
      expect(result.exitCode).toBe(1);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.success).toBe(false);
      expect(json.error).toBeTruthy();
    },
    120000
  );

  // ════════════════════════════════════════════════════════════════════════
  // Archive recommendation
  // ════════════════════════════════════════════════════════════════════════

  it.skipIf(!canRun)(
    'archive recommendation fails without --id flag',
    async () => {
      const result = await run(['archive', 'recommendation']);
      expect(result.exitCode).not.toBe(0);
    },
    30000
  );

  it.skipIf(!canRun)(
    'archives the recommendation with --json flag',
    async ctx => {
      if (!recommendationId) ctx.skip();
      await waitForJob('recommendation', recommendationId, ['COMPLETED', 'FAILED']);

      const result = await run(['archive', 'recommendation', '--id', recommendationId, '--json']);
      expect(result.exitCode, `archive recommendation failed: ${result.stderr}\n${result.stdout}`).toBe(0);

      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json).toHaveProperty('success', true);
      expect(json.id).toBe(recommendationId);
      recommendationArchived = true;
    },
    600000
  );

  it.skipIf(!canRun)(
    'local .cli/recommendations no longer contains the archived record',
    ctx => {
      if (!recommendationArchived) ctx.skip();
      const filePath = join(projectPath, 'agentcore', '.cli', 'jobs', 'recommendations', `${recommendationId}.json`);
      expect(existsSync(filePath), `Local record should have been deleted from ${filePath}`).toBe(false);
    },
    30000
  );

  it.skipIf(!canRun)(
    'archiving the same recommendation again returns success false (already deleted)',
    async ctx => {
      if (!recommendationArchived) ctx.skip();
      const result = await run(['archive', 'recommendation', '--id', recommendationId, '--json']);
      expect(result.exitCode).toBe(1);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.success).toBe(false);
      expect(json.error).toBeTruthy();
    },
    120000
  );
});
