import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentActivityRecorder, TodoProgress } from "./activity.ts";

/** Adapter for the pinned rpiv-todo tool's persisted full-state envelope. */
export function summarizeTodoDetails(details: unknown): TodoProgress | undefined {
  if (!details || typeof details !== "object") return undefined;
  const tasks = (details as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return undefined;
  let completed = 0;
  let total = 0;
  for (const task of tasks) {
    if (!task || typeof task !== "object") return undefined;
    switch (task.status) {
      case "deleted": break;
      case "completed": completed++; total++; break;
      case "pending":
      case "in_progress": total++; break;
      default: return undefined; // Unknown schemas must not look like completed work.
    }
  }
  return { completed, total };
}

export function replayTodoProgress(branch: Iterable<unknown>): TodoProgress | undefined {
  let todos: TodoProgress | undefined;
  for (const entry of branch) {
    const e = entry as { type?: string; message?: { role?: string; toolName?: string; details?: unknown } };
    if (e?.type === "message" && e.message?.role === "toolResult" && e.message.toolName === "todo") {
      // A newer unreadable snapshot invalidates the previous summary.
      todos = summarizeTodoDetails(e.message.details);
    }
  }
  return todos;
}

/** Passive, child-local reporting. No tool calls, task text, or private package state. */
export function registerSubagentProgress(
  pi: ExtensionAPI,
  recorder: SubagentActivityRecorder,
  childCount: () => number,
): void {
  let todos: TodoProgress | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let active = false;

  const publish = () => {
    if (active) recorder.reportProgress(childCount(), todos);
  };
  const replay = (ctx: ExtensionContext) => {
    try { todos = replayTodoProgress(ctx.sessionManager.getBranch()); }
    catch { todos = undefined; }
    publish();
  };

  pi.on("session_start", (_event, ctx) => {
    active = true;
    replay(ctx);
    if (timer) clearInterval(timer);
    timer = setInterval(publish, 2_000);
    timer.unref?.();
  });
  pi.on("session_tree", (_event, ctx) => replay(ctx));
  pi.on("session_compact", (_event, ctx) => replay(ctx));
  // Includes tools invoked through codemode. Use the completed result rather
  // than getBranch(): the message may not have been persisted at this point.
  pi.on("tool_execution_end", (event) => {
    if (event.toolName === "todo") {
      todos = summarizeTodoDetails(event.result?.details);
    }
    publish();
  });
  pi.on("session_shutdown", () => {
    active = false;
    if (timer) clearInterval(timer);
    timer = undefined;
  });
}
