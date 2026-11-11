import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ACTIVITY_PHASES = ["starting", "active", "waiting", "done"] as const;
const ACTIVITY_SCOPES = ["agent", "turn", "provider", "streaming", "tool"] as const;
const ACTIVITY_EVENTS = [
  "session_start",
  "input",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "before_provider_request",
  "after_provider_response",
  "message_update",
  "tool_execution_start",
  "tool_call",
  "tool_execution_update",
  "tool_result",
  "tool_execution_end",
  "ask_question",
  "session_shutdown",
] as const;

export type SubagentActivityPhase = (typeof ACTIVITY_PHASES)[number];
export type SubagentActivityScope = (typeof ACTIVITY_SCOPES)[number];
export type SubagentActivityEvent = (typeof ACTIVITY_EVENTS)[number];

export interface SubagentProgress {
  updatedAt: number;
  activeChildren: number;
}

// A separate heartbeat keeps passive counts fresh without resetting stall detection.
export const SUBAGENT_PROGRESS_STALE_MS = 10_000;

export interface SubagentActivityState {
  version: 1;
  runningChildId: string;
  createdAt: number;
  updatedAt: number;
  sequence: number;
  latestEvent: SubagentActivityEvent;
  phase: SubagentActivityPhase;
  agentActive: boolean;
  turnActive: boolean;
  providerActive: boolean;
  toolActive: boolean;
  activeScope?: SubagentActivityScope;
  activeSince?: number;
  waitingSince?: number;
  turnIndex?: number;
  messageEventType?: string;
  toolCallId?: string;
  toolName?: string;
  toolStartedAt?: number;
  toolEndedAt?: number;
  progress?: SubagentProgress;
}

export type ActivityReadResult =
  | { ok: true; activity: SubagentActivityState }
  | { ok: false; reason: "missing" | "invalid" | "wrong-id"; error?: string };

export type SubagentShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

export interface SubagentActivityRecorder {
  reportProgress(activeChildren: number): void;
  sessionStart(): void;
  input(): void;
  beforeAgentStart(): void;
  agentStart(): void;
  agentEndWaiting(): void;
  agentEndDone(): void;
  turnStart(turnIndex?: number): void;
  turnEnd(turnIndex?: number): void;
  beforeProviderRequest(): void;
  afterProviderResponse(): void;
  messageUpdate(messageEventType?: string): void;
  toolExecutionStart(toolCallId?: string, toolName?: string): void;
  toolCall(toolCallId?: string, toolName?: string): void;
  toolExecutionUpdate(toolCallId?: string, toolName?: string): void;
  toolResult(toolCallId?: string, toolName?: string): void;
  toolExecutionEnd(toolCallId?: string, toolName?: string): void;
  askQuestion(): void;
  sessionShutdown(reason: SubagentShutdownReason): void;
}

const ACTIVITY_UPDATE_THROTTLE_MS = 500;
const MAX_WRITE_FAILURES = 3;
const KNOWN_PHASES = new Set(ACTIVITY_PHASES);
const KNOWN_SCOPES = new Set(ACTIVITY_SCOPES);
const KNOWN_EVENTS = new Set(ACTIVITY_EVENTS);
const MAX_ACTIVITY_STRING_LENGTH = 200;

export function getSubagentActivityFile(artifactDir: string, runningChildId: string): string {
  return join(artifactDir, "subagent-activity", `${runningChildId}.json`);
}

function requireObject(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function validateFiniteNumber(object: Record<string, unknown>, fieldName: string): string | null {
  return Number.isFinite(object[fieldName]) ? null : `${fieldName} must be finite`;
}

function validateOptionalFiniteNumber(object: Record<string, unknown>, fieldName: string): string | null {
  const value = object[fieldName];
  return value == null || Number.isFinite(value) ? null : `${fieldName} must be finite when present`;
}

function validateInteger(object: Record<string, unknown>, fieldName: string): string | null {
  return Number.isInteger(object[fieldName]) ? null : `${fieldName} must be an integer`;
}

function validateOptionalInteger(object: Record<string, unknown>, fieldName: string): string | null {
  const value = object[fieldName];
  return value == null || Number.isInteger(value) ? null : `${fieldName} must be an integer when present`;
}

function validateBoolean(object: Record<string, unknown>, fieldName: string): string | null {
  return typeof object[fieldName] === "boolean" ? null : `${fieldName} must be a boolean`;
}

function validateOptionalActivityString(object: Record<string, unknown>, fieldName: string): string | null {
  const value = object[fieldName];
  if (value == null) return null;
  if (typeof value !== "string") return `${fieldName} must be a string when present`;
  if (/\r|\n/.test(value)) return `${fieldName} must not contain newlines`;
  return value.length <= MAX_ACTIVITY_STRING_LENGTH ? null : `${fieldName} is too long`;
}

function invalidActivity(error: string): ActivityReadResult {
  return { ok: false, reason: "invalid", error };
}

function validateActivity(value: unknown, expectedRunningChildId: string): ActivityReadResult {
  const object = requireObject(value);
  if (!object) return invalidActivity("activity must be an object");
  if (object.version !== 1) return invalidActivity("unsupported activity version");
  if (typeof object.runningChildId !== "string") return invalidActivity("runningChildId must be a string");
  if (object.runningChildId !== expectedRunningChildId) return { ok: false, reason: "wrong-id" };
  if (typeof object.latestEvent !== "string" || !KNOWN_EVENTS.has(object.latestEvent as SubagentActivityEvent)) {
    return invalidActivity("unknown latestEvent");
  }
  if (typeof object.phase !== "string" || !KNOWN_PHASES.has(object.phase as SubagentActivityPhase)) {
    return invalidActivity("unknown activity phase");
  }
  if (
    object.activeScope != null &&
    (typeof object.activeScope !== "string" || !KNOWN_SCOPES.has(object.activeScope as SubagentActivityScope))
  ) {
    return invalidActivity("unknown activeScope");
  }

  const validationError = [
    validateFiniteNumber(object, "createdAt"),
    validateFiniteNumber(object, "updatedAt"),
    validateInteger(object, "sequence"),
    validateBoolean(object, "agentActive"),
    validateBoolean(object, "turnActive"),
    validateBoolean(object, "providerActive"),
    validateBoolean(object, "toolActive"),
    validateOptionalFiniteNumber(object, "activeSince"),
    validateOptionalFiniteNumber(object, "waitingSince"),
    validateOptionalInteger(object, "turnIndex"),
    validateOptionalFiniteNumber(object, "toolStartedAt"),
    validateOptionalFiniteNumber(object, "toolEndedAt"),
    validateOptionalActivityString(object, "messageEventType"),
    validateOptionalActivityString(object, "toolCallId"),
    validateOptionalActivityString(object, "toolName"),
  ].find((error) => error != null);
  if (validationError) return invalidActivity(validationError);

  // A bad optional summary must not discard otherwise valid lifecycle state.
  // Readers simply omit indicators until the child publishes a valid snapshot.
  if (object.progress !== undefined && !isSubagentProgress(object.progress)) {
    const { progress: _invalidProgress, ...lifecycle } = object;
    return { ok: true, activity: lifecycle as unknown as SubagentActivityState };
  }

  return { ok: true, activity: object as unknown as SubagentActivityState };
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isSubagentProgress(value: unknown): value is SubagentProgress {
  const progress = requireObject(value);
  return !!progress && Number.isFinite(progress.updatedAt) && isCount(progress.activeChildren);
}

export function progressIndicators(progress: SubagentProgress | undefined, now: number): string[] {
  if (!isSubagentProgress(progress) || now < progress.updatedAt
    || now - progress.updatedAt > SUBAGENT_PROGRESS_STALE_MS) return [];
  const indicators: string[] = [];
  if (progress.activeChildren > 0) indicators.push(`↳ ${progress.activeChildren}`);
  return indicators;
}

export function readSubagentActivityFile(
  activityFile: string,
  expectedRunningChildId: string,
): ActivityReadResult {
  if (!existsSync(activityFile)) return { ok: false, reason: "missing" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(activityFile, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "invalid", error: message };
  }

  return validateActivity(parsed, expectedRunningChildId);
}

// Windows will not replace a file that another process has open (EPERM/EACCES/EBUSY).
// The parent polls the activity file every second, and scanners open new files too.
// Bursts of child events can land inside one such window and would otherwise exhaust
// MAX_WRITE_FAILURES at once, disabling the recorder before it writes "done".
const LOCKED_FILE_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRY_DELAYS_MS = [1, 2, 4, 8, 16, 32, 64, 128];

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameReplacingLockedFile(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= RENAME_RETRY_DELAYS_MS.length || !code || !LOCKED_FILE_CODES.has(code)) throw error;
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

export function writeSubagentActivityFile(activityFile: string, activity: SubagentActivityState): void {
  const dir = dirname(activityFile);
  mkdirSync(dir, { recursive: true });
  const tempFile = join(dir, `${activity.runningChildId}.json.${process.pid}.${activity.sequence}.tmp`);

  try {
    writeFileSync(tempFile, `${JSON.stringify(activity)}\n`, "utf8");
    renameReplacingLockedFile(tempFile, activityFile);
  } catch (error) {
    try {
      unlinkSync(tempFile);
    } catch (cleanupError) {
      // Temp cleanup is best effort; preserve the original write/rename failure
      void cleanupError;
    }
    throw error;
  }
}

function createNoopRecorder(): SubagentActivityRecorder {
  return {
    reportProgress() {},
    sessionStart() {},
    input() {},
    beforeAgentStart() {},
    agentStart() {},
    agentEndWaiting() {},
    agentEndDone() {},
    turnStart() {},
    turnEnd() {},
    beforeProviderRequest() {},
    afterProviderResponse() {},
    messageUpdate() {},
    toolExecutionStart() {},
    toolCall() {},
    toolExecutionUpdate() {},
    toolResult() {},
    toolExecutionEnd() {},
    askQuestion() {},
    sessionShutdown() {},
  };
}

type ToolActivityEvent =
  | "tool_execution_start"
  | "tool_call"
  | "tool_execution_update"
  | "tool_result"
  | "tool_execution_end";

export type ActivityInput =
  | { event: "session_start" }
  | { event: "input" }
  | { event: "before_agent_start" }
  | { event: "agent_start" }
  | { event: "agent_end"; outcome: "waiting" | "done" }
  | { event: "turn_start" | "turn_end"; turnIndex?: number }
  | { event: "before_provider_request" }
  | { event: "after_provider_response" }
  | { event: "message_update"; messageEventType?: string }
  | { event: ToolActivityEvent; toolCallId?: string; toolName?: string }
  | { event: "ask_question" }
  | { event: "session_shutdown"; reason: SubagentShutdownReason };

export type ActivityRest = { phase: "starting" } | { phase: "waiting"; since: number };

export interface ActivityMachineState {
  snapshot: SubagentActivityState;
  rest: ActivityRest;
}

export type ActivityEffect =
  | { kind: "write"; flush: "immediate" | "throttled"; final: boolean }
  | { kind: "stop" };

export function initialActivityMachine(runningChildId: string, createdAt: number): ActivityMachineState {
  return {
    snapshot: {
      version: 1,
      runningChildId,
      createdAt,
      updatedAt: createdAt,
      sequence: 0,
      latestEvent: "session_start",
      phase: "starting",
      agentActive: false,
      turnActive: false,
      providerActive: false,
      toolActive: false,
    },
    rest: { phase: "starting" },
  };
}

function derivedScope(activity: SubagentActivityState): SubagentActivityScope | undefined {
  if (activity.toolActive) return "tool";
  if (activity.providerActive) return "provider";
  if (activity.turnActive) return "turn";
  if (activity.agentActive) return "agent";
  return undefined;
}

function clearExecution(activity: SubagentActivityState): void {
  activity.agentActive = false;
  activity.turnActive = false;
  activity.providerActive = false;
  activity.toolActive = false;
  delete activity.activeScope;
  delete activity.activeSince;
}

function activate(
  activity: SubagentActivityState,
  scope: SubagentActivityScope,
  now: number,
  resetActiveSince = false,
): void {
  activity.phase = "active";
  activity.activeScope = scope;
  if (activity.activeSince == null || resetActiveSince) activity.activeSince = now;
  delete activity.waitingSince;
}

function enterRest(activity: SubagentActivityState, rest: ActivityRest): void {
  clearExecution(activity);
  activity.phase = rest.phase;
  if (rest.phase === "waiting") activity.waitingSince = rest.since;
  else delete activity.waitingSince;
}

function settle(activity: SubagentActivityState, rest: ActivityRest): void {
  const scope = derivedScope(activity);
  if (!scope) {
    enterRest(activity, rest);
    return;
  }
  activity.phase = "active";
  activity.activeScope = scope;
}

function finish(activity: SubagentActivityState): void {
  clearExecution(activity);
  activity.phase = "done";
  delete activity.waitingSince;
}

export function transitionActivity(
  machine: ActivityMachineState,
  input: ActivityInput,
  now: number,
): { machine: ActivityMachineState; effect: ActivityEffect } {
  if (input.event === "session_shutdown" && input.reason !== "quit") {
    return { machine, effect: { kind: "stop" } };
  }

  const next: SubagentActivityState = {
    ...machine.snapshot,
    latestEvent: input.event,
    updatedAt: now,
    sequence: machine.snapshot.sequence + 1,
  };
  let rest = machine.rest;
  let flush: "immediate" | "throttled" = "immediate";
  let final = false;

  switch (input.event) {
    case "session_start":
      rest = { phase: "starting" };
      enterRest(next, rest);
      break;
    case "input":
      break;
    case "before_agent_start":
    case "agent_start":
      next.agentActive = true;
      activate(next, "agent", now);
      break;
    case "agent_end":
      if (input.outcome === "done") {
        finish(next);
        final = true;
      } else {
        rest = { phase: "waiting", since: now };
        enterRest(next, rest);
      }
      break;
    case "ask_question":
      // The subagent paused to ask the orchestrator a question. Park it in the
      // "waiting" phase (do NOT disable the recorder) so the status widget shows
      // it as waiting and recording resumes when the answer arrives.
      rest = { phase: "waiting", since: now };
      enterRest(next, rest);
      break;
    case "turn_start":
      next.agentActive = true;
      next.turnActive = true;
      if (input.turnIndex != null) next.turnIndex = input.turnIndex;
      activate(next, next.toolActive || next.providerActive ? next.activeScope ?? "turn" : "turn", now);
      break;
    case "turn_end":
      next.turnActive = false;
      next.providerActive = false;
      next.toolActive = false;
      if (input.turnIndex != null) next.turnIndex = input.turnIndex;
      settle(next, rest);
      break;
    case "before_provider_request":
      next.providerActive = true;
      activate(next, "provider", now, true);
      break;
    case "after_provider_response":
      next.providerActive = false;
      settle(next, rest);
      break;
    case "message_update":
      flush = "throttled";
      next.agentActive = true;
      next.turnActive = true;
      next.messageEventType = input.messageEventType;
      if (!next.toolActive) activate(next, "streaming", now);
      break;
    case "tool_execution_start":
      next.toolActive = true;
      next.toolCallId = input.toolCallId;
      next.toolName = input.toolName;
      next.toolStartedAt = now;
      activate(next, "tool", now, true);
      break;
    case "tool_call":
    case "tool_execution_update":
      if (input.event === "tool_execution_update") flush = "throttled";
      next.toolActive = true;
      next.toolCallId = input.toolCallId ?? next.toolCallId;
      next.toolName = input.toolName ?? next.toolName;
      activate(next, "tool", now);
      break;
    case "tool_result":
      next.toolCallId = input.toolCallId ?? next.toolCallId;
      next.toolName = input.toolName ?? next.toolName;
      settle(next, rest);
      break;
    case "tool_execution_end":
      next.toolActive = false;
      next.toolCallId = input.toolCallId ?? next.toolCallId;
      next.toolName = input.toolName ?? next.toolName;
      next.toolEndedAt = now;
      settle(next, rest);
      break;
    case "session_shutdown":
      finish(next);
      final = true;
      break;
  }

  return { machine: { snapshot: next, rest }, effect: { kind: "write", flush, final } };
}

type FlushState =
  | { kind: "idle" }
  | { kind: "scheduled"; timer: ReturnType<typeof setTimeout> };

type DisableReason = "final" | "replaced" | "write-failed";

type RecorderMode =
  | { kind: "recording"; flush: FlushState; failures: number; lastFlushAt: number }
  | { kind: "disabled"; reason: DisableReason };

type RecordingMode = Extract<RecorderMode, { kind: "recording" }>;

export function createSubagentActivityRecorder(params: {
  runningChildId?: string;
  activityFile?: string;
  now?: () => number;
}): SubagentActivityRecorder {
  const runningChildId = params.runningChildId?.trim();
  const activityFile = params.activityFile?.trim();
  if (!runningChildId || !activityFile) return createNoopRecorder();

  const now = params.now ?? (() => Date.now());
  let machine = initialActivityMachine(runningChildId, now());
  let mode: RecorderMode = { kind: "recording", flush: { kind: "idle" }, failures: 0, lastFlushAt: 0 };

  function recording(): RecordingMode | null {
    return mode.kind === "recording" ? mode : null;
  }

  function disable(reason: DisableReason): void {
    const current = recording();
    if (!current) return;
    if (current.flush.kind === "scheduled") clearTimeout(current.flush.timer);
    mode = { kind: "disabled", reason };
  }

  function write(): void {
    const current = recording();
    if (!current) return;
    try {
      writeSubagentActivityFile(activityFile, machine.snapshot);
      current.lastFlushAt = now();
      current.failures = 0;
    } catch {
      current.failures += 1;
      if (current.failures >= MAX_WRITE_FAILURES) disable("write-failed");
    }
  }

  function flushImmediately(): void {
    const current = recording();
    if (!current) return;
    if (current.flush.kind === "scheduled") {
      clearTimeout(current.flush.timer);
      current.flush = { kind: "idle" };
    }
    write();
  }

  function flushThrottled(): void {
    const current = recording();
    if (!current || current.flush.kind === "scheduled") return;
    const remainingMs = Math.max(0, ACTIVITY_UPDATE_THROTTLE_MS - (now() - current.lastFlushAt));
    if (remainingMs === 0) {
      write();
      return;
    }
    current.flush = {
      kind: "scheduled",
      timer: setTimeout(() => {
        current.flush = { kind: "idle" };
        write();
      }, remainingMs),
    };
  }

  function dispatch(input: ActivityInput): void {
    if (!recording()) return;
    const step = transitionActivity(machine, input, now());
    machine = step.machine;
    if (step.effect.kind === "stop") {
      disable("replaced");
      return;
    }
    if (step.effect.flush === "immediate") flushImmediately();
    else flushThrottled();
    if (step.effect.final) disable("final");
  }

  return {
    reportProgress(activeChildren) {
      if (!recording()) return;
      const progress = { updatedAt: now(), activeChildren };
      if (!isSubagentProgress(progress)) return;
      machine = { ...machine, snapshot: { ...machine.snapshot, progress } };
      // Do not advance activity.updatedAt, sequence, latestEvent, or phase:
      // a healthy reporter does not mean the agent itself is making progress.
      write();
    },
    sessionStart: () => dispatch({ event: "session_start" }),
    input: () => dispatch({ event: "input" }),
    beforeAgentStart: () => dispatch({ event: "before_agent_start" }),
    agentStart: () => dispatch({ event: "agent_start" }),
    agentEndWaiting: () => dispatch({ event: "agent_end", outcome: "waiting" }),
    agentEndDone: () => dispatch({ event: "agent_end", outcome: "done" }),
    turnStart: (turnIndex) => dispatch({ event: "turn_start", turnIndex }),
    turnEnd: (turnIndex) => dispatch({ event: "turn_end", turnIndex }),
    beforeProviderRequest: () => dispatch({ event: "before_provider_request" }),
    afterProviderResponse: () => dispatch({ event: "after_provider_response" }),
    messageUpdate: (messageEventType) => dispatch({ event: "message_update", messageEventType }),
    toolExecutionStart: (toolCallId, toolName) => dispatch({ event: "tool_execution_start", toolCallId, toolName }),
    toolCall: (toolCallId, toolName) => dispatch({ event: "tool_call", toolCallId, toolName }),
    toolExecutionUpdate: (toolCallId, toolName) => dispatch({ event: "tool_execution_update", toolCallId, toolName }),
    toolResult: (toolCallId, toolName) => dispatch({ event: "tool_result", toolCallId, toolName }),
    toolExecutionEnd: (toolCallId, toolName) => dispatch({ event: "tool_execution_end", toolCallId, toolName }),
    askQuestion: () => dispatch({ event: "ask_question" }),
    sessionShutdown: (reason) => dispatch({ event: "session_shutdown", reason }),
  };
}
