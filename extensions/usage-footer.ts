import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { collectSubagentUsage } from "./interactive-subagents/pi-extension/subagents/usage.ts";
import {
  loadProactiveCompactionConfig,
  readHandoffState,
} from "./interactive-subagents/pi-extension/subagents/proactive-compaction.ts";
import {
  createRunTimerState,
  formatUsageFooterLines,
  getProactiveBoundaryPercent,
  getProactiveHandoffStatus,
  getRunTimerLabel,
  resetRunTimerState,
  settleRunTimer,
  startRunTimer,
  type RunTimerState,
  type UsageFooterSnapshot,
} from "./lib/usage-footer-format.ts";

const TIMER_KEY = Symbol.for("pi-usage-footer/refresh-timer");
const RUN_TIMER_KEY = Symbol.for("pi-usage-footer/run-timer");
const TIMER_WIDGET_KEY = "usage-footer/run-timer";

const proactiveConfig = (() => {
  try {
    return loadProactiveCompactionConfig();
  } catch {
    return null;
  }
})();

const runTimer =
  ((globalThis as any)[RUN_TIMER_KEY] as RunTimerState | undefined) ?? createRunTimerState();
(globalThis as any)[RUN_TIMER_KEY] = runTimer;

function getCurrentPiChildSessionFile(ctx: ExtensionContext): string | null {
  const childId = process.env.PI_SUBAGENT_ID?.trim();
  const childSessionFile = process.env.PI_SUBAGENT_SESSION?.trim();
  const currentSessionFile = ctx.sessionManager.getSessionFile();
  if (
    !childId ||
    !childSessionFile ||
    !currentSessionFile ||
    resolve(childSessionFile) !== resolve(currentSessionFile)
  ) return null;
  return currentSessionFile;
}

function getProactiveStatus(sessionFile: string | null) {
  return sessionFile
    ? getProactiveHandoffStatus(true, readHandoffState(sessionFile)?.phase)
    : null;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getUsageCost(usage: any): number {
  return finiteNumber(usage?.cost?.total);
}

function addUsageTokens(totals: { input: number; output: number }, usage: any): void {
  totals.input += finiteNumber(usage?.input);
  totals.output += finiteNumber(usage?.output);
}

function summarizeMainUsage(entries: any[]): { cost: number; input: number; output: number; hasInput: boolean; hasOutput: boolean; hasCost: boolean } {
  const totals = { cost: 0, input: 0, output: 0, hasInput: false, hasOutput: false, hasCost: false };
  const add = (usage: any) => {
    totals.cost += getUsageCost(usage);
    totals.hasInput ||= typeof usage?.input === "number" && Number.isFinite(usage.input);
    totals.hasOutput ||= typeof usage?.output === "number" && Number.isFinite(usage.output);
    totals.hasCost ||= typeof usage?.cost?.total === "number" && Number.isFinite(usage.cost.total);
    addUsageTokens(totals, usage);
  };
  for (const entry of entries) {
    if (entry.type === "usage") add(entry.usage);
    else if (
      entry.type === "message" &&
      (entry.message?.role === "assistant" || entry.message?.role === "toolResult")
    ) add(entry.message.usage);
    else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) add(entry.usage);
  }
  return totals;
}

export default function usageFooter(pi: ExtensionAPI) {
  let latestCtx: ExtensionContext | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let snapshot: UsageFooterSnapshot | null = null;
  let requestRender: (() => void) | null = null;

  const previousTimer = (globalThis as any)[TIMER_KEY] as
    | ReturnType<typeof setInterval>
    | undefined;
  if (previousTimer) clearInterval(previousTimer);
  (globalThis as any)[TIMER_KEY] = null;

  function refreshStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI || ctx.mode !== "tui") return;

    const entries = ctx.sessionManager.getEntries();
    const mainUsage = summarizeMainUsage(entries);
    const rootArtifactDir = join(
      ctx.sessionManager.getSessionDir(),
      "artifacts",
      ctx.sessionManager.getSessionId(),
    );
    const children = collectSubagentUsage(rootArtifactDir);
    const supportsSubagents = pi.getAllTools().some((tool) => tool.name === "subagent");
    const context = ctx.getContextUsage();
    const childSessionFile = getCurrentPiChildSessionFile(ctx);
    // The proactive handoff implementation is active only in Pi child sessions.
    const proactiveEnabled = childSessionFile !== null && proactiveConfig?.enabled === true;

    snapshot = {
      cwd: ctx.cwd,
      model: ctx.model?.id ?? "no-model",
      effort: ctx.thinkingLevel ?? "default",
      contextWindow: context?.contextWindow ?? ctx.model?.contextWindow ?? 0,
      contextPercent: context?.percent ?? null,
      inputTokens: mainUsage.hasInput ? mainUsage.input : null,
      outputTokens: mainUsage.hasOutput ? mainUsage.output : null,
      mainCost: mainUsage.hasCost ? mainUsage.cost : null,
      subagentCost: children.sessionCount === 0 ? 0 : children.costAvailable ? children.cost : null,
      showSubagentCost: supportsSubagents,
      proactiveCompactionEnabled: proactiveEnabled,
      compactionCount: proactiveEnabled
        ? entries.filter((entry) => entry.type === "compaction").length
        : null,
      proactiveStatus: getProactiveStatus(childSessionFile),
      proactiveBoundaryPercent: getProactiveBoundaryPercent(
        childSessionFile !== null,
        proactiveConfig,
      ),
      runDurationLabel: getRunTimerLabel(runTimer),
    };
    requestRender?.();
  }

  function startPolling(ctx: ExtensionContext): void {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    latestCtx = ctx;
    // Remove a timer widget left behind by a previous extension instance.
    ctx.ui.setWidget(TIMER_WIDGET_KEY, undefined, { placement: "aboveEditor" });
    ctx.ui.setFooter((tui, theme, footerData) => {
      const rerender = () => tui.requestRender();
      requestRender = rerender;
      const unsubscribe = footerData.onBranchChange(() => {
        if (latestCtx) refreshStatus(latestCtx);
      });
      return {
        dispose() {
          unsubscribe();
          if (requestRender === rerender) requestRender = null;
        },
        invalidate() {},
        render(width: number) {
          if (!snapshot && latestCtx) refreshStatus(latestCtx);
          return snapshot
            ? formatUsageFooterLines(snapshot, width, theme, { visibleWidth, truncateToWidth })
            : [];
        },
      };
    });
    refreshStatus(ctx);
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (latestCtx) refreshStatus(latestCtx);
    }, 1_000);
    (globalThis as any)[TIMER_KEY] = refreshTimer;
  }

  function updateContext(ctx: ExtensionContext): void {
    if (!latestCtx) return;
    latestCtx = ctx;
    refreshStatus(ctx);
  }

  function stopPolling(): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    if ((globalThis as any)[TIMER_KEY]) (globalThis as any)[TIMER_KEY] = null;
    if (latestCtx?.hasUI) {
      latestCtx.ui.setWidget(TIMER_WIDGET_KEY, undefined, { placement: "aboveEditor" });
      latestCtx.ui.setFooter(undefined);
    }
    latestCtx = null;
    snapshot = null;
    requestRender = null;
  }

  pi.on("session_start", (_event, ctx) => {
    stopPolling();
    const sessionId = ctx.sessionManager.getSessionId();
    if (runTimer.sessionId !== sessionId) resetRunTimerState(runTimer, sessionId);
    if (ctx.isIdle()) settleRunTimer(runTimer);
    else startRunTimer(runTimer);
    startPolling(ctx);
  });
  pi.on("agent_start", (_event, ctx) => {
    startRunTimer(runTimer);
    updateContext(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    settleRunTimer(runTimer);
    updateContext(ctx);
  });
  pi.on("message_end", (_event, ctx) => updateContext(ctx));
  pi.on("model_select", (_event, ctx) => updateContext(ctx));
  pi.on("thinking_level_select", (_event, ctx) => updateContext(ctx));
  pi.on("session_tree", (_event, ctx) => updateContext(ctx));
  pi.on("session_compact", (_event, ctx) => updateContext(ctx));
  pi.on("session_shutdown", () => {
    stopPolling();
    resetRunTimerState(runTimer);
  });
}
