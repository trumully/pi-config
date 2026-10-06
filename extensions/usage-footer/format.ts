const EFFORT_ICONS: Record<string, string> = {
  minimal: "\uF0E7", // lightning bolt
  low: "\uF10C", // empty circle
  medium: "\uF192", // circle with dot
  high: "\uF111", // filled circle
  xhigh: "\uF06D", // flame
  max: "\uF06D", // flame
};

function formatEffort(effort: string): string {
  return EFFORT_ICONS[effort.toLowerCase()] ?? effort;
}

export interface UsageFooterSnapshot {
  cwd: string;
  gitBranch: string | null;
  model: string;
  effort: string;
  contextWindow: number;
  contextPercent: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  mainCost: number | null;
  subagentCost: number | null;
  /** True when a known child cost comes from Claude Code's estimate. */
  subagentCostEstimated: boolean;
  showSubagentCost: boolean;
  proactiveCompactionEnabled: boolean;
  compactionCount: number | null;
  proactiveStatus: ProactiveHandoffStatus | null;
  proactiveBoundaryPercent: number | null;
  runDurationLabel: string | null;
}

export interface ProactiveHandoffStatus {
  label: string;
  color: "warning" | "success" | "accent" | "error";
}

export function getProactiveBoundaryPercent(
  isEligiblePiChild: boolean,
  config: { enabled: boolean; thresholdPercent: number } | null | undefined,
): number | null {
  if (!isEligiblePiChild || !config?.enabled) return null;
  const threshold = config.thresholdPercent;
  return Number.isFinite(threshold) && threshold >= 1 && threshold <= 100 ? threshold : null;
}

export function getProactiveHandoffStatus(
  isChildSession: boolean,
  phase: string | null | undefined,
): ProactiveHandoffStatus | null {
  if (!isChildSession) return null;
  switch (phase) {
    case "requested":
      return { label: "checkpoint requested", color: "warning" };
    case "compacting":
      return { label: "proactive compaction", color: "warning" };
    case "compacted":
      return { label: "checkpoint saved", color: "success" };
    case "resume-pending":
      return { label: "resuming", color: "accent" };
    case "resumed":
      return { label: "resumed from checkpoint", color: "success" };
    case "failed":
      return { label: "checkpoint handoff failed", color: "error" };
    default:
      return null;
  }
}

export interface RunTimerState {
  sessionId: string | null;
  startedAt: number | null;
  lastDurationMs: number | null;
}

export function createRunTimerState(): RunTimerState {
  return { sessionId: null, startedAt: null, lastDurationMs: null };
}

export function resetRunTimerState(state: RunTimerState, sessionId: string | null = null): void {
  state.sessionId = sessionId;
  state.startedAt = null;
  state.lastDurationMs = null;
}

export function startRunTimer(state: RunTimerState, now = Date.now()): void {
  if (state.startedAt === null) state.startedAt = now;
}

export function settleRunTimer(state: RunTimerState, now = Date.now()): void {
  if (state.startedAt === null) return;
  state.lastDurationMs = Math.max(0, now - state.startedAt);
  state.startedAt = null;
}

export function formatElapsedDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
}

export function getRunTimerLabel(state: RunTimerState, now = Date.now()): string | null {
  if (state.startedAt !== null) {
    return `Running ${formatElapsedDuration(now - state.startedAt)}`;
  }
  return state.lastDurationMs === null
    ? null
    : `Ran for ${formatElapsedDuration(state.lastDurationMs)}`;
}

export interface FooterTextHelpers {
  visibleWidth(text: string): number;
  truncateToWidth(text: string, width: number): string;
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return Math.round(tokens).toString();
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  if (tokens < 10_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  return `${Math.round(tokens / 1_000_000)}M`;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(3)}`;
}

function directoryName(path: string): string {
  const parts = (path || "?").replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.at(-1) || path || "?";
}

function fit(textValue: string, width: number, text: FooterTextHelpers): string {
  if (width <= 0) return "";
  return text.visibleWidth(textValue) <= width ? textValue : text.truncateToWidth(textValue, width);
}

export function formatUsageFooterLines(
  snapshot: UsageFooterSnapshot,
  width: number,
  theme: { fg(color: any, text: string): string },
  text: FooterTextHelpers,
): string[] {
  if (width <= 0) return [];

  const directory = directoryName(snapshot.cwd);
  const location = snapshot.gitBranch ? `${directory} (${snapshot.gitBranch})` : directory;
  const model = snapshot.model || "no-model";
  const effort = snapshot.effort || "default";
  const line1 = fit(`${location} · ${formatEffort(effort)} ${model}`, width, text);

  const cap = snapshot.contextWindow > 0 ? formatTokens(snapshot.contextWindow) : "?";
  const rawPercent = typeof snapshot.contextPercent === "number" && Number.isFinite(snapshot.contextPercent)
    ? snapshot.contextPercent
    : null;
  const percent = rawPercent === null ? "?" : `${Math.round(rawPercent)}%`;
  const context = `${percent}/${cap}`;
  const contextColor = rawPercent !== null && rawPercent > 90
    ? "error"
    : rawPercent !== null && rawPercent > 70 ? "warning" : "accent";

  let cost: string | null = null;
  let split: string | null = null;
  const estimatePrefix = snapshot.subagentCostEstimated ? "~" : "";
  if (snapshot.showSubagentCost) {
    if (snapshot.mainCost !== null && snapshot.subagentCost !== null) {
      cost = `~${formatCost(snapshot.mainCost + snapshot.subagentCost)}`;
      split = `main ${formatCost(snapshot.mainCost)} + sub ${estimatePrefix}${formatCost(snapshot.subagentCost)}`;
    } else if (snapshot.mainCost !== null) cost = `~${formatCost(snapshot.mainCost)}+?`;
    else if (snapshot.subagentCost !== null) cost = `~?+${estimatePrefix}${formatCost(snapshot.subagentCost)}`;
    else cost = "~?";
  } else if (snapshot.mainCost !== null) cost = `~${formatCost(snapshot.mainCost)}`;
  else cost = "~?";

  const actionableStatus = snapshot.proactiveStatus?.color === "success"
    ? null
    : snapshot.proactiveStatus;
  const statusLabels: Record<string, string> = {
    "checkpoint requested": "requested",
    "proactive compaction": "compacting",
    resuming: "resuming",
    "checkpoint handoff failed": "checkpoint failed",
  };
  const statusText = actionableStatus
    ? `↻ ${statusLabels[actionableStatus.label] ?? actionableStatus.label}`
    : null;
  const activeTimer = snapshot.runDurationLabel?.startsWith("Running ")
    ? snapshot.runDurationLabel
    : null;
  const base = fit(context, width, text);
  let line = base;
  const append = (value: string | null): boolean => {
    if (!value) return false;
    const candidate = `${line} · ${value}`;
    if (text.visibleWidth(candidate) > width) return false;
    line = candidate;
    return true;
  };
  const visibleCost = cost !== null && append(cost);
  let visibleStatus: string | null = null;
  if (statusText) {
    const remaining = width - text.visibleWidth(line) - (line ? 3 : 0);
    if (remaining > 0) {
      const status = fit(statusText, remaining, text);
      if (status && append(status)) visibleStatus = status;
    }
  }
  const visibleSplit = split !== null && text.visibleWidth(`${line} (${split})`) <= width;
  if (visibleSplit) line = `${line} (${split})`;
  const visibleTimer = append(activeTimer);

  const styledParts = [theme.fg(contextColor, base)];
  if (visibleCost) styledParts.push(theme.fg("dim", ` · ${cost}`));
  if (visibleStatus) styledParts.push(theme.fg(actionableStatus!.color, ` · ${visibleStatus}`));
  if (visibleSplit) styledParts.push(theme.fg("dim", ` (${split})`));
  if (visibleTimer) styledParts.push(theme.fg("dim", ` · ${activeTimer}`));

  return [theme.fg("muted", line1), styledParts.join("")];
}


