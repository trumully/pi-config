/**
 * Extension loaded into sub-agents.
 * - Shows an on-demand agent identity + available tools panel (toggle with Ctrl+Alt+O)
 * - Provides an `ask_question` tool for asking the parent orchestrator a question
 *
 * Subagents do NOT self-terminate via a tool. Auto-exit agents shut down
 * automatically once the agent has settled (see the `agent_settled` handler;
 * `agent_end` is not final because Pi may still retry or run queued work);
 * interactive agents end when the human exits the pane.
 *
 * `ask_question` keeps the session OPEN: it writes a `${sessionFile}.ask`
 * signal the parent's watcher picks up, parks the session in a "waiting" state
 * (the handoff controller blocks auto-exit until a reply arrives), and the parent
 * replies with subagent_message - which lands as the subagent's next input.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createSubagentActivityRecorder } from "./activity.ts";
import { registerSubagentProgress } from "./progress.ts";
import { createHandoffController } from "./handoff-controller.ts";
import {
  loadProactiveCompactionConfig,
  parseProactiveCompactionConfig,
  validateProactiveCheckpoint,
  type ProactiveCompactionConfig,
} from "./proactive-compaction.ts";

/**
 * Number of child subagents this session itself still has in flight.
 *
 * When this extension is loaded inside a subagent that can spawn its own
 * children (e.g. a worker delegating to scout/researcher), `index.ts` runs in
 * the same process and publishes a live count through a shared process-global
 * symbol. A subagent that spawns children and then writes a "waiting for
 * results" message would otherwise auto-exit the instant that turn ends -
 * killing the session before its children report back. Reading this count lets
 * `agent_end` keep the session open until every child has finished and its
 * result has been delivered.
 *
 * Returns 0 when the spawning tools aren't loaded (scout/researcher, or a
 * standalone session), so those agents auto-exit exactly as before.
 */
export function runningChildrenCount(): number {
  const fn = (globalThis as any)[Symbol.for("pi-subagents/running-children-count")];
  if (typeof fn !== "function") return 0;
  try {
    const n = fn();
    return typeof n === "number" && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function shouldAutoExitOnAgentEnd(
  messages: any[] | undefined,
  handoffPending = false,
): boolean {
  if (handoffPending) return false;

  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true - we want to shut down so the parent is woken up - but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  // This module is explicitly loaded into Pi subagents, not the orchestrator.
  // Keep it inert if it is ever discovered in a non-child session.
  const runningChildId = process.env.PI_SUBAGENT_ID?.trim();
  const sessionFile = process.env.PI_SUBAGENT_SESSION?.trim();
  if (!runningChildId || !sessionFile) return;

  let toolNames: string[] = [];
  let panelVisible = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const recorder = createSubagentActivityRecorder({
    runningChildId,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  let proactiveConfig: ProactiveCompactionConfig;
  let proactiveConfigError: string | undefined;
  try {
    proactiveConfig = loadProactiveCompactionConfig();
  } catch (error) {
    proactiveConfig = parseProactiveCompactionConfig({});
    proactiveConfigError = error instanceof Error ? error.message : String(error);
  }

  const handoff = createHandoffController({
    sessionFile,
    config: proactiveConfig,
    autoExit,
    sendUserMessage: (text, options) => pi.sendUserMessage(text, options),
    runningChildrenCount,
    lastRunAllowsExit: (messages) => shouldAutoExitOnAgentEnd(messages),
  });

  function notify(ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" | "error" = "info") {
    if (ctx?.hasUI) ctx.ui.notify(message, level);
  }

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    if (!panelVisible) {
      ctx.ui.setWidget("subagent-tools", undefined, { placement: "aboveEditor" });
      return;
    }

    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));
        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";
        const countInfo = theme.fg("dim", ` - ${toolNames.length} available`);
        const hint = theme.fg("muted", "  (Ctrl+Alt+O to hide)");
        const toolList = toolNames
          .map((name: string) => theme.fg("dim", name))
          .join(theme.fg("muted", ", "));
        box.addChild(new Text(`${agentTag}${countInfo}${hint}\n${toolList}`, 0, 0));
        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  // Keep the child tools panel hidden until explicitly requested.
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    renderWidget(ctx, null);
    if (proactiveConfigError) notify(ctx, `${proactiveConfigError} Using the default 70% checkpoint threshold.`, "warning");
    handoff.sessionStart(ctx);
  });

  pi.on("input", (event, ctx) => {
    recorder.input();
    const text = typeof (event as any)?.text === "string" ? (event as any).text as string : "";
    return handoff.input(text, (event as any)?.source, ctx);
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", (_event, ctx) => {
    handoff.agentStart(ctx);
    recorder.agentStart();
  });

  pi.on("turn_end", (_event, ctx) => {
    handoff.turnEnd(ctx);
  });

  pi.on("agent_end", (event) => {
    handoff.agentEnd((event as any).messages as any[] | undefined);
  });

  pi.on("agent_settled", (event, ctx) => {
    const decision = handoff.agentSettled((event as any).aborted === true, ctx);
    if (decision.kind !== "exit") {
      recorder.agentEndWaiting();
      return;
    }

    // Surface stopReason: "error" turns (auto-retry exhausted, provider
    // overload, etc.) to the parent via the .exit sidecar so the watcher
    // can report a clear failure with the underlying error message.
    // Without this the parent would only see exit code 0 and a stale
    // assistant message, mistaking the crash for a successful completion.
    const errorInfo = findLatestAssistantError(handoff.lastRunMessages());
    if (errorInfo) {
      try {
        writeFileSync(
          `${sessionFile}.exit`,
          JSON.stringify({
            type: "error",
            errorMessage: errorInfo.errorMessage,
            stopReason: errorInfo.stopReason,
          }),
        );
      } catch {
        // Best effort - even without the sidecar, watcher's session-file
        // fallback can still recover the errorMessage.
      }
    }

    recorder.agentEndDone();
    ctx.shutdown();
  });

  pi.on("session_compact", (event, ctx) => {
    if ((event as any).reason === "manual") handoff.manualCompactSucceeded(ctx);
  });

  pi.on("session_compact_failed", (event, ctx) => {
    const failure = event as any;
    if (failure.reason !== "manual") return;
    handoff.manualCompactFailed(
      failure.errorMessage ?? (failure.aborted ? "Compaction was aborted." : "Compaction failed."),
      failure.aborted === true,
      ctx,
    );
  });

  pi.on("turn_start", (event, ctx) => {
    handoff.turnStart(ctx);
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event, ctx) => {
    handoff.sessionShutdown((event as any).reason, ctx);
    recorder.sessionShutdown((event as any).reason);
  });

  // Register after lifecycle handlers so sessionStart initializes the activity
  // snapshot before the first progress publication, and shutdown disables it.
  registerSubagentProgress(pi, recorder, runningChildrenCount);

  // Toggle the child tools panel with Ctrl+Alt+O.
  pi.registerShortcut("ctrl+alt+o", {
    description: "Toggle subagent tools panel",
    handler: (ctx) => {
      panelVisible = !panelVisible;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "ask_question",
    label: "ask_question",
    description:
      "Ask the orchestrator (the parent agent that spawned you) a single question and pause until they reply. " +
      "Use this when requirements are ambiguous, a decision would materially affect your work, you're blocked, " +
      "or you need information or confirmation only the orchestrator has. Prefer asking over guessing. " +
      "Your session stays open while you wait - the answer arrives as your next message, then you continue. " +
      "Ask exactly one question per call; make separate calls for unrelated questions.",
    promptSnippet:
      "Use this tool to ask the orchestrator one clarifying, missing-requirement, preference, or decision question before continuing - instead of guessing.",
    promptGuidelines: [
      "Ask exactly one question per tool call.",
      "If you need answers to multiple things, make separate ask_question calls instead of bundling them.",
      "Prefer this tool over guessing when requirements, preferences, or implementation choices are unclear.",
      "Use it when multiple valid paths exist and the right one depends on the orchestrator's intent.",
      "Give enough context in the question that the orchestrator can answer without re-reading your whole task.",
      "After asking, stop and wait - the reply will arrive as your next message.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description:
          "The single freeform question to ask the orchestrator. Include enough context to answer it directly.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "ask_question is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      // Keep the session open: suppress auto-exit for this turn and park in the
      // "waiting" phase. The parent's watcher picks up the `.ask` signal and
      // notifies the orchestrator, who replies via subagent_message.
      handoff.askQuestion();
      recorder.askQuestion();
      const askData = {
        id: randomUUID(),
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        agent: process.env.PI_SUBAGENT_AGENT ?? "",
        question: params.question,
      };
      // Write atomically so the parent watcher never reads a partial question.
      const askFile = `${sessionFile}.ask`;
      const tempFile = `${askFile}.tmp-${process.pid}-${askData.id}`;
      writeFileSync(tempFile, JSON.stringify(askData));
      renameSync(tempFile, askFile);

      const result = {
        content: [
          {
            type: "text",
            text:
              "Question sent to the orchestrator. Stop here and wait - do not continue working or " +
              "assume an answer. Their reply will arrive as your next message.",
          },
        ],
        details: { question: params.question },
      };
      // Pi's agent loop uses `terminate` to skip the automatic model request
      // after this tool batch. `Object.assign` keeps the result compatible with
      // older peer type definitions that don't declare this runtime field.
      return Object.assign(result, { terminate: true as const });
    },

    renderCall(args, theme) {
      const text =
        theme.fg("toolTitle", theme.bold("ask_question ")) +
        theme.fg("muted", String((args as any).question ?? ""));
      return new Text(text, 0, 0);
    },
  });

  if (proactiveConfig.enabled) {
    const checkpointSchema = Type.Object({
      goal: Type.String({ minLength: 1, maxLength: 8_000, description: "The user's goal this child must finish." }),
      task: Type.String({ minLength: 1, maxLength: 8_000, description: "The precise task or requested deliverable." }),
      completed: Type.Array(Type.String({ maxLength: 2_000 }), { maxItems: 40, description: "Completed work so far." }),
      inProgress: Type.String({ minLength: 1, maxLength: 8_000, description: "The current atomic step and any incomplete state; say 'None' if between steps." }),
      decisions: Type.Array(Type.String({ maxLength: 2_000 }), { maxItems: 40, description: "Important decisions and their rationale." }),
      verifiedTests: Type.Array(Type.String({ maxLength: 2_000 }), { maxItems: 40, description: "Tests or checks actually run and their results; use an empty list if none." }),
      nextAction: Type.String({ minLength: 1, maxLength: 8_000, description: "One precise next action that continues the task, not a generic plan." }),
    });

    pi.registerTool({
      name: "self_compact",
      label: "Checkpoint and compact",
      description:
        "Save a structured continuation checkpoint for this child task, end the current run, compact the session while idle, then continue the task from the checkpoint. " +
        "Call only when the proactive checkpoint request arrives or when you otherwise need to preserve a long task. This does not mean the task is complete.",
      promptSnippet:
        "Save a continuation checkpoint and compact the child session; the task resumes from the checkpoint and is not complete.",
      promptGuidelines: [
        "When asked to checkpoint, complete the current atomic tool/action first, then call self_compact once.",
        "Record the original goal and task, completed work, exact in-progress state, decisions, verified tests, and one precise next action.",
        "Do not report task completion as part of the checkpoint; continue after the compaction succeeds.",
      ],
      parameters: checkpointSchema,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const checkpoint = validateProactiveCheckpoint(params);
        if (!checkpoint) throw new Error("self_compact requires a complete, bounded continuation checkpoint.");
        const handoffId = randomUUID();
        const rejection = handoff.selfCompact(checkpoint, handoffId, ctx);
        if (rejection) {
          return {
            content: [{ type: "text", text: rejection }],
            details: { error: "handoff already pending" },
            isError: true,
          };
        }

        return Object.assign({
          content: [{ type: "text", text: "Checkpoint saved. The child will compact at the idle boundary and resume the task; do not report completion yet." }],
          details: { handoffId },
        }, { terminate: true as const });
      },
      renderCall(_args, theme) {
        return new Text(theme.fg("toolTitle", theme.bold("Checkpoint and compact")), 0, 0);
      },
      renderResult(result, _opts, theme) {
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "Checkpoint saved.";
        return new Text(theme.fg(result.isError ? "error" : "success", text), 0, 0);
      },
    });
  }

}
