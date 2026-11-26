import { z } from 'zod';
import { ADVISOR_MODELS } from '../core/defaults.js';
import { capOutputTail } from '../core/logging.js';
import { DelegationAttempt, FallbackAgent, TargetAgent } from '../core/types.js';
import {
  AdvisorEffort,
  consultAdvisor,
  getAdvisorConfig,
  resolveAdvisorModels,
  setAdvisorConfig,
} from '../services/dispatcher/advisor-service.js';
import { validateWorkDir } from '../utils/validation.js';
import { dispatchJob, ToolContext, ToolResponse } from './execution.js';

function formatAdvisorAttempts(attempts?: DelegationAttempt[]): string {
  if (!attempts || attempts.length === 0) return '';
  if (attempts.length === 1 && attempts[0].exitCode === 0) return '';
  return (
    '\n\nFailover Attempts:\n' +
    attempts
      .map(
        (a, i) =>
          `  [Attempt ${i + 1}: ${a.agent}] Exit ${a.exitCode} (${Math.round(a.durationMs / 1000)}s):\n${
            a.outputTail ? `    ${a.outputTail.trim().replace(/\n/g, '\n    ')}` : '    (no output)'
          }`
      )
      .join('\n')
  );
}

export const configureAdvisorSchema = z.object({
  advisor: z
    .enum(['auto', 'agy', 'codex', 'claude'])
    .optional()
    .describe(
      `Set the active session advisor provider. "auto" routes across external top-tier models by live quota; "agy" uses ${ADVISOR_MODELS.agy.model} (${ADVISOR_MODELS.agy.effort}), "codex" uses ${ADVISOR_MODELS.codex.model} (${ADVISOR_MODELS.codex.effort}), "claude" uses ${ADVISOR_MODELS.claude.model} (${ADVISOR_MODELS.claude.effort}). Omit all fields to inspect current config.`
    ),
  model: z
    .string()
    .optional()
    .describe('Optional model override for the chosen advisor provider. Pass empty string to clear override and revert to the strongest default.'),
  effort: z
    .enum(['low', 'medium', 'high', 'xhigh', 'max'])
    .optional()
    .describe('Optional reasoning effort override for the advisor (low|medium|high|xhigh|max).'),
  fallback_agent: z
    .enum(['agy', 'codex', 'claude', 'none'])
    .optional()
    .describe('Optional default fallback advisor provider, or "none" to pin without failover.'),
  reset: z
    .boolean()
    .optional()
    .describe('Reset session advisor configuration back to defaults (auto, strongest callable models).'),
});

export type ConfigureAdvisorInput = z.input<typeof configureAdvisorSchema>;

export function handleConfigureAdvisor(rawInput: ConfigureAdvisorInput = {}): ToolResponse {
  const input = configureAdvisorSchema.parse(rawInput);
  const hasUpdates =
    input.reset === true ||
    input.advisor !== undefined ||
    input.model !== undefined ||
    input.effort !== undefined ||
    input.fallback_agent !== undefined;

  const active = hasUpdates
    ? setAdvisorConfig({
        advisor: input.advisor as TargetAgent | undefined,
        model: input.model,
        effort: input.effort as AdvisorEffort | undefined,
        fallbackAgent: input.fallback_agent as FallbackAgent | undefined,
        reset: input.reset,
      })
    : getAdvisorConfig();

  const resolved = resolveAdvisorModels(active.advisor, active.model, active.effort);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            active,
            effective_models: resolved,
            strongest_defaults: ADVISOR_MODELS,
          },
          null,
          2
        ),
      },
    ],
  };
}

export const consultAdvisorSchema = z.object({
  async: z
    .boolean()
    .optional()
    .default(true)
    .describe('Return a job_id immediately and poll get_job_result; false waits synchronously.'),
  question: z
    .string()
    .min(1)
    .describe('The hard problem, architectural decision, debugging impasse, or design question to discuss with the advisor.'),
  context: z
    .string()
    .optional()
    .describe('Optional background: what has already been tried, error messages, hypotheses, constraints, or prior advisor summary.'),
  advisor: z
    .enum(['auto', 'agy', 'codex', 'claude'])
    .optional()
    .describe(
      `Advisor provider to consult. Defaults to the session setting from configure_advisor (initially "auto"). Strongest defaults: agy=${ADVISOR_MODELS.agy.model} (${ADVISOR_MODELS.agy.effort}), codex=${ADVISOR_MODELS.codex.model} (${ADVISOR_MODELS.codex.effort}), claude=${ADVISOR_MODELS.claude.model} (${ADVISOR_MODELS.claude.effort}).`
    ),
  fallback_agent: z
    .enum(['agy', 'codex', 'claude', 'none'])
    .optional()
    .describe('Explicit fallback advisor if primary is depleted/unavailable, or "none" to pin without failover.'),
  balance_quota: z
    .boolean()
    .optional()
    .default(true)
    .describe('Check live quotas before dispatch and fail over automatically if the chosen advisor is depleted.'),
  work_dir: z
    .string()
    .min(1)
    .describe('Absolute path to existing working directory (read-only inspection boundary for the advisor).'),
  model: z
    .string()
    .optional()
    .describe('Optional one-off model override for the chosen advisor provider.'),
  effort: z
    .enum(['low', 'medium', 'high', 'xhigh', 'max'])
    .optional()
    .describe('Optional one-off reasoning effort override (low|medium|high|xhigh|max).'),
  timeout_sec: z
    .number()
    .int()
    .min(0)
    .max(86400)
    .optional()
    .default(0)
    .describe('Optional execution timeout in seconds. Default 0 = no limit.'),
});

export type ConsultAdvisorInput = z.input<typeof consultAdvisorSchema>;

export async function handleConsultAdvisor(rawInput: ConsultAdvisorInput, context: ToolContext = {}): Promise<ToolResponse> {
  const dirCheck = validateWorkDir(rawInput.work_dir);
  if (!dirCheck.valid) {
    return {
      isError: true,
      content: [{ type: 'text', text: dirCheck.error! }],
    };
  }

  const input = consultAdvisorSchema.parse(rawInput);
  if (input.async) {
    return dispatchJob('consult_advisor', jobContext => handleConsultAdvisor({ ...input, async: false }, jobContext));
  }

  try {
    const result = await consultAdvisor({
      question: input.question,
      context: input.context,
      advisor: input.advisor as TargetAgent | undefined,
      fallbackAgent: input.fallback_agent as FallbackAgent | undefined,
      balanceQuota: input.balance_quota,
      workDir: input.work_dir,
      model: input.model,
      effort: input.effort as AdvisorEffort | undefined,
      timeoutSec: input.timeout_sec,
      signal: context.signal,
      onProgress: context.onProgress,
    });

    context.onResult?.(result);
    const textOutput = result.output || result.stdout || result.stderr;
    const logInfo = result.logPath ? `Log: ${result.logPath}\n` : '';
    const attemptsInfo = formatAdvisorAttempts(result.attempts);
    const advisorLabel = `${result.usedAgent} (${result.advisorModel} / ${result.advisorEffort})`;

    if (result.exitCode !== 0) {
      const parts: string[] = [];
      if (result.stdout && result.stdout.trim()) {
        parts.push(`Stdout:\n${capOutputTail(result.stdout, 10000, result.logPath)}`);
      }
      if (result.stderr && result.stderr.trim()) {
        parts.push(`Stderr:\n${capOutputTail(result.stderr, 10000, result.logPath)}`);
      }
      const failureDetails = parts.length > 0 ? parts.join('\n\n') : (capOutputTail(textOutput, 10000, result.logPath) || 'No output recorded.');

      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Advisor consultation [${advisorLabel}] failed (Exit ${result.exitCode}):\n${logInfo}\n${failureDetails}${attemptsInfo}`,
          },
        ],
      };
    }

    const cappedOutput = capOutputTail(textOutput, 20000, result.logPath);
    return {
      content: [
        {
          type: 'text',
          text: `[Advisor: ${advisorLabel}] (Duration: ${Math.round(result.durationMs / 1000)}s)\n${logInfo}\n${cappedOutput}${attemptsInfo}`,
        },
      ],
    };
  } catch (error: any) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Unexpected advisor consultation error: ${error?.message || String(error)}`,
        },
      ],
    };
  }
}
