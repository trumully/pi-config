import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentActivityRecorder } from "./activity.ts";

/** Passive, child-local reporting of active descendants. */
export function registerSubagentProgress(
  pi: ExtensionAPI,
  recorder: SubagentActivityRecorder,
  childCount: () => number,
): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let active = false;

  const publish = () => {
    if (active) recorder.reportProgress(childCount());
  };

  pi.on("session_start", () => {
    active = true;
    publish();
    if (timer) clearInterval(timer);
    timer = setInterval(publish, 2_000);
    timer.unref?.();
  });
  pi.on("session_tree", publish);
  pi.on("tool_execution_end", publish);
  pi.on("session_shutdown", () => {
    active = false;
    if (timer) clearInterval(timer);
    timer = undefined;
  });
}
