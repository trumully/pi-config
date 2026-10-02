const EFFORT_ICONS: Record<string, string> = {
  minimal: "\uF0E7", // lightning bolt
  low: "\uF10C", // empty circle
  medium: "\uF192", // circle with dot
  high: "\uF111", // filled circle
  xhigh: "\uF06D", // flame
  max: "\uF06D", // flame
};

function formatEffort(effort: string): string {
  const level = effort.toLowerCase();
  const icon = EFFORT_ICONS[level];
  if (!icon) return effort;

  const label = level === "minimal" ? "min" : level === "medium" ? "med" : level === "xhigh" ? "xhi" : level;
  return `${icon} ${label}`;
}

export interface UsageFooterSnapshot {
  cwd: string;
  model: string;
  effort: string;
  contextWindow: number;
  contextPercent: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  mainCost: number | null;
  subagentCost: number | null;
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

function keepPathTail(text: string, width: number, visibleWidth: FooterTextHelpers["visibleWidth"]): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const chars = [...text];
  let start = 0;
  while (start < chars.length && visibleWidth(`…${chars.slice(start).join("")}`) > width) start++;
  return start === chars.length ? "…" : `…${chars.slice(start).join("")}`;
}

function wrapParts(
  parts: string[],
  width: number,
  text: FooterTextHelpers,
): string[] {
  const lines: string[] = [];
  for (const originalPart of parts) {
    const part = text.visibleWidth(originalPart) > width
      ? text.truncateToWidth(originalPart, width)
      : originalPart;
    const lastLine = lines.at(-1);
    const candidate = lastLine ? `${lastLine} · ${part}` : part;
    if (lastLine && text.visibleWidth(candidate) > width) lines.push(part);
    else if (lastLine) lines[lines.length - 1] = candidate;
    else lines.push(part);
  }
  return lines;
}

export function formatUsageFooterLines(
  snapshot: UsageFooterSnapshot,
  width: number,
  theme: { fg(color: any, text: string): string },
  text: FooterTextHelpers,
): string[] {
  if (width <= 0) return [];

  const modelPart = `${snapshot.model || "no-model"} · ${formatEffort(snapshot.effort || "default")}`;
  const modelWidth = text.visibleWidth(modelPart);
  const topLines: string[] = [];
  if (modelWidth + 3 <= width) {
    const cwd = keepPathTail(snapshot.cwd || "?", width - modelWidth - 2, text.visibleWidth);
    topLines.push(`${theme.fg("muted", cwd)}${" ".repeat(width - text.visibleWidth(cwd) - modelWidth)}${theme.fg("accent", modelPart)}`);
  } else {
    topLines.push(theme.fg("muted", keepPathTail(snapshot.cwd || "?", width, text.visibleWidth)));
    topLines.push(theme.fg("accent", keepPathTail(modelPart, width, text.visibleWidth)));
  }

  const contextCap = snapshot.contextWindow > 0 ? formatTokens(snapshot.contextWindow) : "?";
  const percent = typeof snapshot.contextPercent === "number" && Number.isFinite(snapshot.contextPercent)
    ? snapshot.contextPercent
    : null;
  const contextPercent = percent === null ? "?" : `${Math.round(percent)}%`;
  const contextColor = percent !== null && percent > 90
    ? "error"
    : percent !== null && percent > 70 ? "warning" : "accent";
  const filledCells = percent === null
    ? 0
    : Math.round(Math.min(100, Math.max(0, percent)) / 10);
  const boundary = snapshot.proactiveBoundaryPercent;
  const boundaryCell = typeof boundary === "number" && Number.isFinite(boundary) && boundary >= 1 && boundary <= 100
    ? Math.max(0, Math.min(9, Math.round(boundary / 10) - 1))
    : -1;
  const cells = Array.from({ length: 10 }, (_, index) => {
    if (index === boundaryCell) return theme.fg("warning", "│");
    return index < filledCells ? theme.fg(contextColor, "█") : theme.fg("dim", "░");
  }).join("");
  const boundaryLabel = boundaryCell >= 0 ? ` · compact ~${Math.round(boundary!)}%` : "";
  const context = `${cells} ${contextPercent}/${contextCap}${boundaryLabel}`;
  const tokenParts = [
    snapshot.inputTokens === null ? null : `↑${formatTokens(snapshot.inputTokens)}`,
    snapshot.outputTokens === null ? null : `↓${formatTokens(snapshot.outputTokens)}`,
  ].filter((part): part is string => part !== null);
  const usageLine = `${context}${tokenParts.length ? theme.fg("dim", ` · ${tokenParts.join(" ")}`) : ""}`;
  const parts = [usageLine];
  if (snapshot.showSubagentCost) {
    if (snapshot.mainCost !== null && snapshot.subagentCost !== null) {
      const totalCost = snapshot.mainCost + snapshot.subagentCost;
      parts.push(theme.fg("dim", `~${formatCost(totalCost)} (main ${formatCost(snapshot.mainCost)} · subagents ${formatCost(snapshot.subagentCost)})`));
    }
  } else if (snapshot.mainCost !== null) {
    parts.push(theme.fg("dim", `~${formatCost(snapshot.mainCost)}`));
  }
  if (snapshot.proactiveCompactionEnabled && snapshot.compactionCount !== null) {
    parts.push(theme.fg("dim", `↻ ${snapshot.compactionCount}`));
  }
  if (snapshot.proactiveStatus) {
    parts.push(theme.fg(snapshot.proactiveStatus.color, `↻ ${snapshot.proactiveStatus.label}`));
  }
  const footerLines = [...topLines, ...wrapParts(parts, width, text)];

  if (snapshot.runDurationLabel) {
    footerLines.push(theme.fg("dim", text.truncateToWidth(snapshot.runDurationLabel, width)));
  }
  return footerLines;
}

export interface SubagentFooterLine {
  name: string;
  status: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  compactionCount?: number;
}

function subagentMetricParts(line: Pick<SubagentFooterLine, "inputTokens" | "outputTokens" | "cost" | "compactionCount">): string[] {
  const parts: string[] = [];
  if (typeof line.inputTokens === "number" && Number.isFinite(line.inputTokens)) parts.push(`↑${formatTokens(line.inputTokens)}`);
  if (typeof line.outputTokens === "number" && Number.isFinite(line.outputTokens)) parts.push(`↓${formatTokens(line.outputTokens)}`);
  if (typeof line.cost === "number" && Number.isFinite(line.cost)) parts.push(formatCost(line.cost));
  if (typeof line.compactionCount === "number" && Number.isFinite(line.compactionCount)) parts.push(`↻ ${line.compactionCount}`);
  return parts;
}

/** Formats the metrics suffix shared by the live widget and result indicator. */
export function formatSubagentFooterStats(
  line: Pick<SubagentFooterLine, "inputTokens" | "outputTokens" | "cost" | "compactionCount">,
): string {
  return subagentMetricParts(line).join(" · ");
}

/** Formats one compact subagent status row for completed results. */
export function formatSubagentFooterLine(
  line: SubagentFooterLine,
  width: number,
  theme: { fg(color: any, text: string): string; bold?(text: string): string },
  text: FooterTextHelpers,
): string {
  const parts = [
    theme.fg("toolTitle", theme.bold ? theme.bold(line.name) : line.name),
    theme.fg(line.status === "failed" || line.status === "stalled" ? "error" : line.status === "running" ? "warning" : "success", line.status),
    ...subagentMetricParts(line),
  ];
  const formatted = parts.join(theme.fg("dim", " · "));
  return text.visibleWidth(formatted) > width ? text.truncateToWidth(formatted, width) : formatted;
}
