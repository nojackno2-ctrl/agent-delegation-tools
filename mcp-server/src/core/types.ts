export type AgentName = 'codex' | 'claude' | 'agy';
export type TargetAgent = 'auto' | AgentName;
export type FallbackAgent = AgentName | 'none';

export type TaskType = 'analysis' | 'implementation' | 'review' | 'scaffolding';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type AvailabilityStatus = 'available' | 'depleted' | 'unavailable';

export interface QuotaWindow {
  name: string;
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: string | null;
  resetsAtUnix?: number | null;
}

export interface AgentQuotaReport {
  agent: AgentName;
  availability: AvailabilityStatus;
  observedAt?: string;
  message: string;
  windows?: QuotaWindow[];
}

export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output?: string;
  durationMs: number;
  timedOut?: boolean;
}

export const EXIT_CODES = {
  SUCCESS: 0,
  GENERIC_FAILURE: 1,
  QUOTA_EXCEEDED: 10,
  ALL_DEPLETED: 75,
  CONFIG_AUTH_ERROR: 78,
  TIMEOUT: 124,
} as const;
