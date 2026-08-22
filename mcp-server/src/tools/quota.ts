import { z } from 'zod';
import { getAllQuotas, getAgentQuota } from '../services/quota/quota-service.js';
import { AgentQuotaReport } from '../core/types.js';

export const getAgentQuotasSchema = z.object({
  agent: z
    .enum(['all', 'codex', 'claude', 'agy'])
    .optional()
    .default('all')
    .describe('Which agent pool to inspect. Defaults to "all" for all three providers.'),
  timeout_sec: z
    .number()
    .int()
    .min(1)
    .max(300)
    .optional()
    .default(20)
    .describe('Timeout in seconds for live quota queries.'),
  work_dir: z
    .string()
    .optional()
    .describe('Working directory context for resolving local configurations.'),
  bypass_cache: z
    .boolean()
    .optional()
    .default(false)
    .describe('Bypass the in-memory 10-second quota cache and perform live queries immediately.'),
});

export type GetAgentQuotasInput = z.infer<typeof getAgentQuotasSchema>;

export async function handleGetAgentQuotas(input: GetAgentQuotasInput) {
  try {
    let reports: AgentQuotaReport[];

    if (!input.agent || input.agent === 'all') {
      reports = await getAllQuotas({
        timeoutSec: input.timeout_sec,
        workDir: input.work_dir,
        bypassCache: input.bypass_cache,
      });
    } else {
      const single = await getAgentQuota(input.agent, {
        timeoutSec: input.timeout_sec,
        workDir: input.work_dir,
        bypassCache: input.bypass_cache,
      });
      reports = [single];
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(reports, null, 2),
        },
      ],
    };
  } catch (error: any) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Error querying agent quotas: ${error?.message || String(error)}`,
        },
      ],
    };
  }
}
