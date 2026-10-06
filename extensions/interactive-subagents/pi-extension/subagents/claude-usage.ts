import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const SIDECAR_VERSION = 1;
const FINAL_SIDECAR_SOURCE = "claude-code-cost-state";
const LIVE_SIDECAR_SOURCE = "claude-code-statusline";

/** Claude Code reports a price estimate, not a provider-billed final charge. */
export interface ClaudeCostEstimate {
  estimated: true;
  cost: number | null;
  costAvailable: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  sessionId: string | null;
  /** Claude explicitly reported that at least one model's price is unknown. */
  costExplicitlyUnknown?: boolean;
}

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function sumModelMetric(modelUsage: unknown, key: string): number | null {
  if (!modelUsage || typeof modelUsage !== "object" || Array.isArray(modelUsage)) return null;
  let total = 0;
  let found = false;
  for (const usage of Object.values(modelUsage as Record<string, unknown>)) {
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) continue;
    const value = (usage as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      total += value;
      found = true;
    }
  }
  return found ? total : null;
}

/** Read the last Claude `cost-state` transcript record without retaining message content. */
export function readClaudeCostEstimate(transcriptFile: string | null): ClaudeCostEstimate | null {
  if (!transcriptFile) return null;

  let latest: Record<string, unknown> | null = null;
  try {
    for (const line of readFileSync(transcriptFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as unknown;
        if (entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "cost-state") {
          latest = entry as Record<string, unknown>;
        }
      } catch {
        // Ignore incomplete trailing lines in a transcript that was still flushing.
      }
    }
  } catch {
    return null;
  }
  if (!latest) return null;

  const totalCost = nonnegativeNumber(latest.totalCostUSD);
  const costAvailable = totalCost !== null && latest.hasUnknownModelCost !== true;
  return {
    estimated: true,
    cost: costAvailable ? totalCost : null,
    costAvailable,
    inputTokens: sumModelMetric(latest.modelUsage, "inputTokens"),
    outputTokens: sumModelMetric(latest.modelUsage, "outputTokens"),
    cacheReadTokens: sumModelMetric(latest.modelUsage, "cacheReadInputTokens"),
    cacheWriteTokens: sumModelMetric(latest.modelUsage, "cacheCreationInputTokens"),
    sessionId: typeof latest.sessionId === "string" ? latest.sessionId : null,
    ...(latest.hasUnknownModelCost === true ? { costExplicitlyUnknown: true } : {}),
  };
}

/** Prefer final Claude totals, but retain the latest live cost when no final cost exists. */
export function reconcileClaudeCostEstimates(
  live: ClaudeCostEstimate | null,
  final: ClaudeCostEstimate | null,
): ClaudeCostEstimate | null {
  if (!live) return final;
  if (!final) return live;

  const sessionMismatch = Boolean(final.sessionId && live.sessionId && final.sessionId !== live.sessionId);
  if (sessionMismatch) return final;
  // An explicit unknown-model signal is authoritative: do not turn an unknown
  // final cost into a known number using an older status-line snapshot.
  if (final.costExplicitlyUnknown) return final;

  const finalCostAvailable = final.costAvailable && nonnegativeNumber(final.cost) !== null;
  const liveCostAvailable = live.costAvailable && nonnegativeNumber(live.cost) !== null;
  return {
    estimated: true,
    cost: finalCostAvailable ? final.cost : liveCostAvailable ? live.cost : null,
    costAvailable: finalCostAvailable || liveCostAvailable,
    inputTokens: final.inputTokens ?? live.inputTokens,
    outputTokens: final.outputTokens ?? live.outputTokens,
    cacheReadTokens: final.cacheReadTokens ?? live.cacheReadTokens,
    cacheWriteTokens: final.cacheWriteTokens ?? live.cacheWriteTokens,
    sessionId: final.sessionId ?? live.sessionId,
  };
}

/** Persist one small per-run usage sidecar for the footer; never copies transcript text. */
export function writeClaudeUsageSidecar(
  path: string,
  estimate: ClaudeCostEstimate | null,
  source: "statusline" | "cost-state" = "cost-state",
): void {
  const costAvailable = estimate?.costAvailable === true && nonnegativeNumber(estimate.cost) !== null;
  const record: ClaudeCostEstimate & { version: number; source: string } = {
    version: SIDECAR_VERSION,
    source: source === "statusline" ? LIVE_SIDECAR_SOURCE : FINAL_SIDECAR_SOURCE,
    estimated: true,
    cost: costAvailable ? estimate!.cost : null,
    costAvailable,
    inputTokens: nonnegativeNumber(estimate?.inputTokens),
    outputTokens: nonnegativeNumber(estimate?.outputTokens),
    cacheReadTokens: nonnegativeNumber(estimate?.cacheReadTokens),
    cacheWriteTokens: nonnegativeNumber(estimate?.cacheWriteTokens),
    sessionId: estimate?.sessionId ?? null,
  };

  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temp, JSON.stringify(record) + "\n", "utf8");
  renameSync(temp, path);
}

/** Read and validate a usage sidecar written by this module. */
export function readClaudeUsageSidecar(path: string): ClaudeCostEstimate | null {
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (
      record.version !== SIDECAR_VERSION ||
      (record.source !== FINAL_SIDECAR_SOURCE && record.source !== LIVE_SIDECAR_SOURCE) ||
      record.estimated !== true
    ) return null;

    const cost = nonnegativeNumber(record.cost);
    const costAvailable = record.costAvailable === true && cost !== null;
    return {
      estimated: true,
      cost: costAvailable ? cost : null,
      costAvailable,
      inputTokens: nonnegativeNumber(record.inputTokens),
      outputTokens: nonnegativeNumber(record.outputTokens),
      cacheReadTokens: nonnegativeNumber(record.cacheReadTokens),
      cacheWriteTokens: nonnegativeNumber(record.cacheWriteTokens),
      sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
    };
  } catch {
    return null;
  }
}
