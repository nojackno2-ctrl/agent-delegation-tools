import { z } from 'zod';
import { JobRegistry, jobRegistry } from '../services/jobs/job-registry.js';

export const getJobStatusSchema = z.object({ job_id: z.string().min(1).optional() });
export const getJobResultSchema = z.object({
  job_id: z.string().min(1),
  wait_sec: z.number().min(0).max(50).optional().default(25),
});
export const cancelJobSchema = z.object({ job_id: z.string().min(1) });
const response = (value: unknown, isError = false) => ({ isError, content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const missing = (id: string) => response({ error: `Unknown or expired job: ${id}` }, true);
export function handleGetJobStatus(input: z.infer<typeof getJobStatusSchema>, registry = jobRegistry) {
  if (input.job_id) {
    const job = registry.get(input.job_id);
    if (!job) return missing(input.job_id);
    const { result: _result, ...brief } = job;
    return response(brief);
  }
  return response(registry.list().map(({ result: _result, ...brief }) => brief));
}
export async function handleGetJobResult(input: z.infer<typeof getJobResultSchema>, registry: JobRegistry = jobRegistry) {
  const job = await registry.wait(input.job_id, input.wait_sec);
  return job ? response(job) : missing(input.job_id);
}
export async function handleCancelJob(input: z.infer<typeof cancelJobSchema>, registry = jobRegistry) {
  const job = await registry.cancel(input.job_id);
  return job ? response(job) : missing(input.job_id);
}
