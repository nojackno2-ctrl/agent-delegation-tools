export type AgentName = 'codex' | 'claude' | 'agy';
export type TargetAgent = 'auto' | AgentName;
export type FallbackAgent = AgentName | 'none';

export type TaskType = 'analysis' | 'implementation' | 'review' | 'scaffolding';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type AvailabilityStatus = 'available' | 'depleted' | 'unavailable' | 'logged_out';

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

export interface DelegationAttempt {
  agent: AgentName;
  exitCode: number;
  durationMs: number;
  errorTail: string;
}

export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output?: string;
  durationMs: number;
  timedOut?: boolean;
  cancelled?: boolean;
  logPath?: string;
  attempts?: DelegationAttempt[];
}

export const EXIT_CODES = {
  SUCCESS: 0,
  GENERIC_FAILURE: 1,
  QUOTA_EXCEEDED: 10,
  ALL_DEPLETED: 75,
  CONFIG_AUTH_ERROR: 78,
  ENVIRONMENT_FAILURE: 79,
  TIMEOUT: 124,
  CANCELLED: 130,
} as const;
