import {
  advanceThresholdLatch,
  branchHasAssistantAfterResumeToken,
  branchHasCompactionAfter,
  branchHasResumeToken,
  formatCheckpoint,
  handoffNeedsToStayOpen,
  handoffSidecarExists,
  readHandoffState,
  writeHandoffState,
  type ProactiveCheckpoint,
  type ProactiveCompactionConfig,
  type ProactiveHandoffState,
} from "./proactive-compaction.ts";

export const CHECKPOINT_REQUEST_MARKER = "[pi-subagent-checkpoint-request]";

export type QuestionState = { kind: "none" } | { kind: "awaiting-reply" };

export type CheckpointRequestState =
  | { kind: "idle" }
  | { kind: "queued" }
  | { kind: "delivered" };

export type ContinuationState =
  | { kind: "unowned" }
  | { kind: "deferred-input"; text: string }
  | { kind: "input-owned" }
  | { kind: "dispatched" };

export type HandoffControllerState =
  | { kind: "none" }
  | { kind: "unreadable" }
  | {
    kind: "cycle";
    record: ProactiveHandoffState;
    origin: "live" | "recovered";
    continuation: ContinuationState;
  };

export type InputSource = "interactive" | "rpc" | "extension" | string | undefined;

export type InputResult =
  | undefined
  | { action: "transform"; text: string }
  | { action: "handled" };

export type SettleDecision =
  | { kind: "exit" }
  | { kind: "stay-open"; reason: StayOpenReason };

export type StayOpenReason =
  | "auto-exit-disabled"
  | "aborted"
  | "awaiting-reply"
  | "handoff-open"
  | "checkpoint-request-pending"
  | "running-children"
  | "pending-messages";

export interface HandoffContext {
  hasUI?: boolean;
  ui?: { notify(message: string, level?: "info" | "warning" | "error"): void };
  sessionManager: { getBranch(): any[] };
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  getContextUsage(): { percent?: number | null } | undefined | null;
  compact(options: {
    customInstructions?: string;
    onComplete?: (result: unknown) => void;
    onError?: (error: Error) => void;
  }): void;
}

export interface HandoffControllerDeps {
  sessionFile: string;
  config: ProactiveCompactionConfig;
  autoExit: boolean;
  sendUserMessage(text: string, options: { deliverAs: "steer" }): void;
  runningChildrenCount(): number;
  lastRunAllowsExit(messages: any[] | undefined): boolean;
}

export interface HandoffController {
  readonly state: {
    readonly question: QuestionState;
    readonly request: CheckpointRequestState;
    readonly handoff: HandoffControllerState;
    readonly thresholdLatched: boolean;
  };
  handoffOpen(): boolean;
  sessionStart(ctx: HandoffContext): void;
  input(text: string, source: InputSource, ctx: HandoffContext): InputResult;
  agentStart(ctx: HandoffContext): void;
  turnStart(ctx: HandoffContext): void;
  turnEnd(ctx: HandoffContext): void;
  agentEnd(messages: any[] | undefined): void;
  agentSettled(aborted: boolean, ctx: HandoffContext): SettleDecision;
  lastRunMessages(): any[] | undefined;
  manualCompactSucceeded(ctx: HandoffContext): void;
  manualCompactFailed(error: string, aborted: boolean, ctx: HandoffContext): void;
  sessionShutdown(reason: string | undefined, ctx: HandoffContext): void;
  askQuestion(): void;
  selfCompact(checkpoint: ProactiveCheckpoint, id: string, ctx: HandoffContext): string | undefined;
}

export function resumeTokenFor(record: ProactiveHandoffState): string {
  return record.resumeToken ?? `[pi-subagent-self-compact:${record.id}]`;
}

function resumePrompt(record: ProactiveHandoffState, token: string, instruction?: string): string {
  return [
    `Continue the original child task from this saved checkpoint. Do not report completion until the task is actually finished. ${token}`,
    formatCheckpoint(record.checkpoint),
    ...(instruction ? [`Additional instruction: ${instruction}`] : []),
  ].join("\n\n");
}

function inputContinuation(record: ProactiveHandoffState, text: string, token: string): string {
  return [
    "Continue the child task from this checkpoint. Do not treat the handoff as task completion.",
    formatCheckpoint(record.checkpoint),
    `Additional instruction: ${text}`,
    token,
  ].join("\n\n");
}

function joinInstructions(first: string | undefined, second: string): string {
  return first ? `${first}\n\n${second}` : second;
}

export function createHandoffController(deps: HandoffControllerDeps): HandoffController {
  let question: QuestionState = { kind: "none" };
  let request: CheckpointRequestState = { kind: "idle" };
  let handoff: HandoffControllerState = { kind: "none" };
  let thresholdLatched = false;
  let active = true;
  let finalRunMessages: any[] | undefined;
  let latestCtx: HandoffContext | undefined;

  function notify(ctx: HandoffContext | undefined, message: string, level: "info" | "warning" | "error" = "info") {
    const target = ctx ?? latestCtx;
    if (target?.hasUI) target.ui?.notify(message, level);
  }

  function handoffOpen(): boolean {
    if (handoff.kind === "unreadable") return true;
    return handoff.kind === "cycle" && handoffNeedsToStayOpen(handoff.record);
  }

  function cycle() {
    return handoff.kind === "cycle" ? handoff : undefined;
  }

  function save(record: ProactiveHandoffState, ctx?: HandoffContext, continuation?: ContinuationState): boolean {
    const current = cycle();
    handoff = {
      kind: "cycle",
      record,
      origin: current?.origin ?? "recovered",
      continuation: continuation ?? current?.continuation ?? { kind: "unowned" },
    };
    try {
      writeHandoffState(deps.sessionFile, record);
      return true;
    } catch (error) {
      notify(ctx, `Could not persist self_compact handoff state: ${error instanceof Error ? error.message : String(error)}`, "error");
      return false;
    }
  }

  function deferredText(): string | undefined {
    const current = cycle();
    return current?.continuation.kind === "deferred-input" ? current.continuation.text : undefined;
  }

  function sendResume(record: ProactiveHandoffState, token: string, instruction?: string) {
    const current = cycle();
    if (current) handoff = { ...current, continuation: { kind: "dispatched" } };
    deps.sendUserMessage(resumePrompt(record, token, instruction), { deliverAs: "steer" });
  }

  function dispatchResume(ctx: HandoffContext): void {
    const current = cycle();
    if (!active || !current || current.continuation.kind === "dispatched") return;
    const record = current.record;
    const token = resumeTokenFor(record);
    if (branchHasResumeToken(ctx.sessionManager.getBranch(), token)) {
      save({ ...record, phase: "resumed", resumeToken: token }, ctx, { kind: "unowned" });
      return;
    }

    const pending = { ...record, phase: "resume-pending" as const, resumeToken: token };
    if (!save(pending, ctx)) return;
    const continuation = cycle()!.continuation;
    if (continuation.kind === "deferred-input") {
      sendResume(pending, token, continuation.text);
      return;
    }
    // A user/parent message accepted while compaction ran is itself the
    // continuation. The input transition added the checkpoint to that message.
    if (continuation.kind === "input-owned" || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    sendResume(pending, token);
  }

  function failCompaction(error: string, aborted: boolean, ctx?: HandoffContext): void {
    const current = cycle();
    if (!current || current.record.phase !== "compacting") return;
    const held = deferredText();
    if (held !== undefined) {
      const token = resumeTokenFor(current.record);
      const next = { ...current.record, phase: "resume-pending" as const, resumeToken: token, error, aborted };
      save(next, ctx);
      if (active) sendResume(next, token, held);
      notify(ctx, `Proactive child compaction did not finish; continuing from the saved checkpoint with the held message. ${error}`, "warning");
      return;
    }
    const owned = current.continuation.kind === "input-owned";
    save({ ...current.record, phase: owned ? "resume-pending" : "failed", error, aborted }, ctx);
    notify(
      ctx,
      aborted
        ? "Proactive child compaction was aborted. The checkpoint is saved; the child is waiting for input."
        : `Proactive child compaction failed. The checkpoint is saved; the child is waiting for input. ${error}`,
      aborted ? "warning" : "error",
    );
  }

  function recover(ctx: HandoffContext): void {
    const sidecarExists = handoffSidecarExists(deps.sessionFile);
    const loaded = readHandoffState(deps.sessionFile);
    if (!loaded) {
      handoff = sidecarExists ? { kind: "unreadable" } : { kind: "none" };
      if (sidecarExists) {
        thresholdLatched = true;
        notify(ctx, "The child self_compact checkpoint is unreadable. The child will stay open rather than report an incomplete task.", "error");
      }
      return;
    }
    thresholdLatched = true;

    handoff = { kind: "cycle", record: loaded, origin: "recovered", continuation: { kind: "unowned" } };
    const branch = ctx.sessionManager.getBranch();
    let record = loaded;
    if (record.phase === "compacting" && record.compactionBaselineEntryCount !== undefined) {
      record = branchHasCompactionAfter(branch, record.compactionBaselineEntryCount)
        ? { ...record, phase: "compacted" }
        : { ...record, phase: "failed", error: "Interrupted before a successful compaction was recorded." };
      save(record, ctx);
    } else if (record.phase === "requested" && branchHasCompactionAfter(branch, record.requestEntryCount)) {
      record = { ...record, phase: "compacted" };
      save(record, ctx);
    }

    if (
      (record.phase === "resume-pending" || record.phase === "resumed") &&
      branchHasResumeToken(branch, record.resumeToken)
    ) {
      save({ ...record, phase: "resumed" }, ctx);
    } else if (record.phase === "resumed") {
      // A crash after the phase write but before the resume prompt reached the
      // transcript is safe to recover from the next explicit input.
      save({ ...record, phase: "resume-pending" }, ctx);
    }
  }

  function finishAcceptedResume(ctx: HandoffContext): void {
    const current = cycle();
    if (!current || current.continuation.kind !== "input-owned" || current.record.phase !== "resume-pending") return;
    save({ ...current.record, phase: "resumed" }, ctx, { kind: "unowned" });
  }

  function markCompleted(ctx: HandoffContext): void {
    const current = cycle();
    if (
      current?.record.phase === "resumed" &&
      branchHasAssistantAfterResumeToken(ctx.sessionManager.getBranch(), current.record.resumeToken)
    ) {
      save({ ...current.record, phase: "completed" }, ctx);
    }
  }

  function handoffInput(text: string, ctx: HandoffContext): InputResult {
    if (handoff.kind === "unreadable") {
      // The sidecar cannot be trusted, so never silently exit with a potentially
      // incomplete task. A new explicit instruction is the recovery boundary.
      handoff = { kind: "none" };
      thresholdLatched = true;
      notify(ctx, "Continuing without the unreadable checkpoint; native automatic compaction remains enabled.", "warning");
      return undefined;
    }

    const current = cycle();
    if (!current) return undefined;
    const { record } = current;
    if (!handoffNeedsToStayOpen(record) && record.phase !== "failed") return undefined;

    const token = resumeTokenFor(record);
    const tokenized = text.includes(token);

    if (record.phase === "requested" && current.origin === "live" && !tokenized) {
      handoff = { ...current, continuation: { kind: "deferred-input", text: joinInstructions(deferredText(), text) } };
      notify(ctx, "Message held until the child finishes compacting; it will be delivered with the checkpoint.", "info");
      return { action: "handled" };
    }

    const held = deferredText();
    const next = record.phase === "compacting"
      ? { ...record, resumeToken: token }
      : { ...record, phase: "resume-pending" as const, resumeToken: token };
    save(next, ctx, { kind: "input-owned" });
    if (tokenized) return undefined;
    return { action: "transform", text: inputContinuation(record, joinInstructions(held, text), token) };
  }

  return {
    get state() {
      return { question, request, handoff, thresholdLatched };
    },
    handoffOpen,

    sessionStart(ctx) {
      latestCtx = ctx;
      recover(ctx);
    },

    input(text, source, ctx) {
      latestCtx = ctx;
      if (source !== "extension") question = { kind: "none" };
      if (request.kind === "queued") request = { kind: "delivered" };
      return handoffInput(text, ctx);
    },

    agentStart(ctx) {
      finishAcceptedResume(ctx);
    },

    turnStart(ctx) {
      if (request.kind === "delivered") request = { kind: "idle" };
      finishAcceptedResume(ctx);
    },

    turnEnd(ctx) {
      if (!deps.config.enabled || handoffOpen() || question.kind === "awaiting-reply") return;
      const next = advanceThresholdLatch(thresholdLatched, ctx.getContextUsage()?.percent, deps.config.thresholdPercent);
      thresholdLatched = next.latched;
      if (!next.request) return;

      // turn_end fires after the assistant's complete tool batch. Steering here
      // asks for a checkpoint before the next model request without interrupting
      // an in-flight tool or changing Pi's native automatic compaction path.
      request = { kind: "queued" };
      deps.sendUserMessage(
        `${CHECKPOINT_REQUEST_MARKER} Context usage reached ${deps.config.thresholdPercent}%. ` +
          "Finish the current atomic step, then call self_compact exactly once with a checkpoint containing: goal, task, completed work, in-progress state, decisions, verified tests, and one precise next action. " +
          "Do not report task completion. The child will continue the task after compaction.",
        { deliverAs: "steer" },
      );
    },

    agentEnd(messages) {
      finalRunMessages = messages;
    },

    lastRunMessages() {
      return finalRunMessages;
    },

    agentSettled(aborted, ctx) {
      latestCtx = ctx;
      const current = cycle();
      if (active && current?.record.phase === "requested" && ctx.isIdle() && !ctx.hasPendingMessages()) {
        startCompaction(current.record, ctx);
      }
      return decideExit(aborted, ctx);
    },

    manualCompactSucceeded(ctx) {
      const current = cycle();
      if (current?.record.phase === "compacting") save({ ...current.record, phase: "compacted" }, ctx);
    },

    manualCompactFailed(error, aborted, ctx) {
      failCompaction(error, aborted, ctx);
    },

    sessionShutdown(reason, ctx) {
      if (reason === "quit") markCompleted(ctx);
      active = false;
    },

    askQuestion() {
      question = { kind: "awaiting-reply" };
    },

    selfCompact(checkpoint, id, ctx) {
      if (handoffOpen()) return "A checkpoint handoff is already pending; do not request another one.";
      const record: ProactiveHandoffState = {
        version: 1,
        id,
        phase: "requested",
        createdAt: Date.now(),
        requestEntryCount: ctx.sessionManager.getBranch().length,
        checkpoint,
      };
      // Save synchronously before asking Pi to end the run. If persistence
      // fails, fail the tool call instead of risking an untracked handoff.
      writeHandoffState(deps.sessionFile, record);
      handoff = { kind: "cycle", record, origin: "live", continuation: { kind: "unowned" } };
      thresholdLatched = true;
      request = { kind: "idle" };
      return undefined;
    },
  };

  function startCompaction(record: ProactiveHandoffState, ctx: HandoffContext): void {
    // The installed Pi runtime emits agent_settled only after native retry,
    // compaction, and queued continuation have completed. Its context is idle;
    // the caller verified that before invoking the manual compact API (which
    // aborts active work if called at the wrong time).
    const branch = ctx.sessionManager.getBranch();
    if (branchHasCompactionAfter(branch, record.requestEntryCount)) {
      if (save({ ...record, phase: "compacted" }, ctx)) dispatchResume(ctx);
      return;
    }

    const baseline = branch.length;
    if (!save({ ...record, phase: "compacting", compactionBaselineEntryCount: baseline }, ctx)) {
      failCompaction("Could not persist the compaction phase; no compaction was started.", false, ctx);
      return;
    }

    ctx.compact({
      customInstructions:
        "This is a proactive continuation handoff, not task completion. Preserve the checkpoint and its precise next action in the summary:\n\n" +
        formatCheckpoint(record.checkpoint),
      onComplete: () => {
        const current = cycle();
        if (
          !active ||
          !current ||
          current.record.id !== record.id ||
          (current.record.phase !== "compacting" && current.record.phase !== "compacted")
        ) return;
        if (!branchHasCompactionAfter(ctx.sessionManager.getBranch(), baseline)) {
          failCompaction("Pi reported compaction success but no compaction entry was recorded.", false, ctx);
          return;
        }
        if (save({ ...current.record, phase: "compacted" }, ctx)) dispatchResume(ctx);
      },
      onError: (error) => {
        if (!active) return;
        failCompaction(error.message, /abort|cancel/i.test(error.message), ctx);
      },
    });
  }

  function decideExit(aborted: boolean, ctx: HandoffContext): SettleDecision {
    // Never shut down while work is in flight: a pending question, a proactive
    // checkpoint handoff, a queued threshold request, or children whose results
    // are still outstanding all keep this same process alive. The parent watcher
    // reports completion only when the Pi process actually exits.
    const stay = (reason: StayOpenReason): SettleDecision => ({ kind: "stay-open", reason });
    if (!deps.autoExit) return stay("auto-exit-disabled");
    if (aborted || !deps.lastRunAllowsExit(finalRunMessages)) return stay("aborted");
    if (question.kind === "awaiting-reply") return stay("awaiting-reply");
    if (handoffOpen()) return stay("handoff-open");
    if (request.kind !== "idle") return stay("checkpoint-request-pending");
    if (deps.runningChildrenCount() > 0) return stay("running-children");
    if (ctx.hasPendingMessages()) return stay("pending-messages");
    markCompleted(ctx);
    return { kind: "exit" };
  }
}
