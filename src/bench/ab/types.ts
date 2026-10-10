// Shared types of the online A/B harness (`kopt bench ab`).

export const ALL_ARMS = ['A', 'B', 'C'] as const;
export type Arm = (typeof ALL_ARMS)[number];
export type Engine = 'v2' | 'v3';

export const ARM_LABEL: Record<Arm, string> = {
  A: 'stock Kiro (no kopt anywhere)',
  B: 'kopt installed (MCP + hooks + steering)',
  C: 'kopt MCP only (no hooks, no steering)',
};

/** Arms that have the kopt MCP server (and therefore need a prebuilt index). */
export const KOPT_ARMS: ReadonlySet<Arm> = new Set<Arm>(['B', 'C']);

export interface AbGold {
  files: string[];
  symbols: string[];
}

export interface AbTask {
  id: string;
  prompt: string;
  kind?: string;
  gold?: AbGold;
}

export interface AbTaskFile {
  tasks: AbTask[];
  /** Grading threshold from the file (`passRatio`), overridden by --pass-ratio. */
  passRatio?: number;
}

export interface PlanItem {
  idx: number;
  runId: string;
  task: string;
  arm: Arm;
  rep: number;
  /** Position of this arm inside its (task, rep) block, 0-based (order effects can be checked afterwards). */
  order: number;
}

export interface Grade {
  pass: boolean;
  symbolsFound: number;
  symbolsTotal: number;
  filesFound: number;
  filesTotal: number;
  missingSymbols: string[];
  missingFiles: string[];
}

export type ErrorKind =
  | 'account_blocked'
  | 'not_logged_in'
  | 'auth_expired'
  | 'quota'
  | 'throttled'
  | 'model_unavailable'
  | 'mcp_startup'
  | 'agent_not_found'
  | 'tool_denied'
  | 'timeout'
  | 'run_error'
  | 'display_error'
  | 'exit_nonzero'
  | 'spawn_failed'
  | 'no_credits'
  | 'zero_credits'
  | 'no_answer'
  | 'kopt_leak'
  | 'budget_exceeded'
  | 'aborted';

/**
 * Kiro refused the request because the account is suspended or locked (its anti-abuse checks: "Your User ID is
 * temporarily suspended. We detected unusual user activity..."). Seen once with 2.28, on the first headless request
 * of an account: a 403 AccessDeniedException in the stream's runError, no credit metered.
 */
export const ACCOUNT_BLOCKED_ADVICE =
  'Kiro blocked this account (anti-abuse). Do not retry and do not resume: every further request goes to a blocked account. ' +
  'Contact Kiro support (https://support.aws.amazon.com/#/contacts/kiro); once they have restored access, continue with --resume --account-restored';

/** Errors that make every further run pointless (or unsafe): the campaign stops at the first one. */
export const FATAL_ERRORS: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  'account_blocked',
  'not_logged_in',
  'auth_expired',
  'quota',
  'model_unavailable',
  'mcp_startup',
  'agent_not_found',
  'tool_denied',
  'spawn_failed',
  'kopt_leak',
  'budget_exceeded',
]);

/**
 * Failures caused by the environment, not by the arm (login, plan limits, backend throttling, the harness itself):
 * `--resume` runs them again (the old attempt is archived and its credits still count). A timeout is retried only
 * when --timeout was raised since the attempt.
 */
export const RETRY_ON_RESUME: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  // only with --account-restored: a campaign that saw this error refuses to send anything without it
  'account_blocked',
  'not_logged_in',
  'auth_expired',
  'quota',
  'throttled',
  'model_unavailable',
  'mcp_startup',
  'agent_not_found',
  'spawn_failed',
  'budget_exceeded',
  'aborted',
]);

/**
 * Invalid runs that are the arm's own doing (no usable answer in the time given, a crash, an error the model ran
 * into): they count as wrong answers in the correctness rule and in the reliability rule of the report.
 */
export const OWN_FAULT_ERRORS: ReadonlySet<ErrorKind> = new Set<ErrorKind>(['timeout', 'no_answer', 'exit_nonzero', 'run_error', 'display_error']);

export interface RunRecord {
  runId: string;
  idx: number;
  task: string;
  kind: string;
  arm: Arm;
  rep: number;
  order: number;
  smoke: boolean;
  engine: Engine;
  model: string;
  startedAt: string;
  wallMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Valid = usable for the comparison: exit 0, no error, credits > 0, an answer. */
  valid: boolean;
  invalidReason?: string;
  errorKind?: ErrorKind;
  errorDetail?: string;
  /** Credits used for the analysis (session file first, stream otherwise). */
  credits?: number;
  creditsSource?: 'session' | 'stream';
  creditsStream?: number;
  creditsSession?: number;
  /** Stream and session totals both present and more than 5% apart. */
  creditsMismatch: boolean;
  turns?: number;
  requests?: number;
  toolCalls: number;
  toolsByName: Record<string, number>;
  /** Tool names from the per-request usage summaries (distinct per request: a lower bound of calls). */
  usedTools: Record<string, number>;
  /** kopt tool calls: kopt's own telemetry (the proof) for kopt arms; completed stream calls as a fallback count for arm A. */
  koptCalls: number;
  koptCallsStream: number;
  koptCallsTelemetry: number;
  /** kopt hook events written by this run (proves the hooks ran). */
  koptHookEvents: number;
  /** kopt tool calls the stream shows as failed or denied (never counted as kopt usage). */
  koptCallsFailed?: number;
  /** Set on a kopt arm run with no kopt tool call proven by kopt's telemetry. */
  koptFlag?: string;
  ctxPctMax?: number;
  answerChars: number;
  answerSource: string;
  grade?: Grade;
  sessionId?: string;
  streamLines: number;
  streamBadLines: number;
  warnings: string[];
  /** The run left changes in the worktree (they were reverted before the next run). */
  dirtyAfter: boolean;
  /** The run moved the worktree's HEAD (a commit or a branch switch by a shell tool); it was reset. */
  headMoved?: boolean;
  /** kiro-cli version this run used. */
  kiroVersion?: string;
  /** Per-run wall-clock limit this run had (seconds). */
  timeoutS?: number;
}
