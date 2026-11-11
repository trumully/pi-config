import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { readSubagentActivityFile } from "./activity.ts";
import { readClaudeUsageSidecar } from "./claude-usage.ts";
import { persistRecordedUsage, readRecordedUsage } from "./recorded-usage.ts";
import {
  getInheritedSessionEntryIds,
  getSessionId,
  readNameRegistry,
  summarizeSessionStats,
  type SessionStats,
} from "./session.ts";

export interface SubagentUsageTotals {
  sessionCount: number;
  runningCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  /** At least one child contributed a known cost. */
  costAvailable: boolean;
  /** Every registered child currently has a known cost; live Claude snapshots count. */
  costComplete: boolean;
  /** Known costs include Claude Code list-price estimates. */
  costEstimated: boolean;
}

interface CachedSessionStats {
  size: number;
  mtimeMs: number;
  stats: SessionStats;
}

const sessionStatsCache = new Map<string, CachedSessionStats>();

function cacheKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function readCachedStats(sessionFile: string): SessionStats | null {
  const key = cacheKey(sessionFile);
  try {
    const file = statSync(sessionFile);
    const cached = sessionStatsCache.get(key);
    if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) {
      return cached.stats;
    }

    const excludedIds = getInheritedSessionEntryIds(sessionFile);
    const stats = summarizeSessionStats(sessionFile, { excludeEntryIds: excludedIds });
    if (!stats) {
      const retained = cached?.stats ?? readRecordedUsage(sessionFile);
      return retained ? { ...retained, costComplete: false } : null;
    }
    if (stats.costAvailable) persistRecordedUsage(sessionFile, excludedIds);

    sessionStatsCache.set(key, { size: file.size, mtimeMs: file.mtimeMs, stats });
    return stats;
  } catch {
    const retained = readRecordedUsage(sessionFile);
    return retained ? { ...retained, costComplete: false } : null;
  }
}

/**
 * Usage shown on one subagent's widget row, excluding its descendants.
 * Pi usage covers only the current launch or resume. Claude usage is what the
 * per-launch sidecar reports; after a resume its cost may include earlier
 * spend in the same Claude session.
 */
export interface RunUsage {
  /** Null when the source reports no cumulative count, as with live Claude snapshots. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** Null when no cost is known. Never treat as zero. */
  cost: number | null;
  /** True for Claude Code list-price estimates. */
  costEstimated: boolean;
  /** False when some usage in this run has no known cost. */
  costComplete: boolean;
}

export interface RunUsageSource {
  sessionFile: string;
  /** Transcript entries that existed before this run started. */
  startEntryCount: number;
  /** Claude usage sidecar. When set, the Pi transcript is not read. */
  usageFile?: string;
}

export interface RunUsageSnapshot {
  file: string;
  startEntryCount: number;
  size: number;
  mtimeMs: number;
  usage: RunUsage | null;
}

function piRunUsage(sessionFile: string, startEntryCount: number): RunUsage | null | undefined {
  const stats = summarizeSessionStats(sessionFile, {
    afterEntryCount: startEntryCount,
    excludeEntryIds: getInheritedSessionEntryIds(sessionFile),
    optionalUsageMissingIsFree: true,
  });
  // Undefined: unreadable now, usually a partly written trailing line.
  if (!stats) return undefined;
  if (!stats.usageAvailable && !stats.costAvailable) return null;
  return {
    inputTokens: stats.inputAvailable ? stats.inputTokens : null,
    outputTokens: stats.outputAvailable ? stats.outputTokens : null,
    cost: stats.costAvailable ? stats.cost : null,
    costEstimated: false,
    costComplete: stats.costComplete !== false,
  };
}

/**
 * The sidecar as reported, without attempting run-local attribution. Live
 * snapshots normally carry a cost estimate but no token totals; final totals
 * arrive at completion, when the widget row usually goes away.
 */
function claudeRunUsage(usageFile: string): RunUsage | null {
  const sidecar = readClaudeUsageSidecar(usageFile);
  if (!sidecar) return null;
  const cost = sidecar.costAvailable ? sidecar.cost : null;
  return {
    inputTokens: sidecar.inputTokens,
    outputTokens: sidecar.outputTokens,
    cost,
    costEstimated: sidecar.estimated,
    costComplete: cost !== null,
  };
}

/**
 * Read one run's own usage for the status widget. Pass the previous snapshot
 * to skip parsing when the source file has not changed.
 */
export function readRunUsage(source: RunUsageSource, previous?: RunUsageSnapshot): RunUsageSnapshot {
  const file = source.usageFile ?? source.sessionFile;
  const sameRun = previous?.file === file && previous.startEntryCount === source.startEntryCount;
  const carried = sameRun ? previous.usage : null;
  let size: number;
  let mtimeMs: number;
  try {
    ({ size, mtimeMs } = statSync(file));
  } catch {
    return { file, startEntryCount: source.startEntryCount, size: -1, mtimeMs: -1, usage: carried };
  }
  if (sameRun && previous.size === size && previous.mtimeMs === mtimeMs) return previous;

  const usage = source.usageFile
    ? claudeRunUsage(source.usageFile)
    : piRunUsage(source.sessionFile, source.startEntryCount);
  return {
    file,
    startEntryCount: source.startEntryCount,
    size,
    mtimeMs,
    usage: usage === undefined ? carried : usage,
  };
}

/** Capture full-session usage at completion, independently of footer polling. */
export function captureSubagentUsage(sessionFile: string): void {
  readCachedStats(sessionFile);
}

function activityIsRunning(activityFile: string): boolean | undefined {
  const childId = basename(activityFile, ".json");
  const result = readSubagentActivityFile(activityFile, childId);
  return result.ok ? result.activity.phase !== "done" : undefined;
}

function countUnlinkedRunningActivityFiles(
  artifactDir: string,
  linkedActivityFiles: Set<string>,
): number {
  const activityDir = join(artifactDir, "subagent-activity");
  let files: string[];
  try {
    files = readdirSync(activityDir).filter((file) => file.endsWith(".json"));
  } catch {
    return 0;
  }

  let count = 0;
  for (const file of files) {
    const activityFile = join(activityDir, file);
    if (linkedActivityFiles.has(cacheKey(activityFile))) continue;
    if (activityIsRunning(activityFile) === true) count++;
  }
  return count;
}

/**
 * Sum usage and live activity for every registered descendant of a session.
 * Forked transcript entries copied from the parent are excluded from usage.
 */
export function collectSubagentUsage(rootArtifactDir: string): SubagentUsageTotals {
  const totals: SubagentUsageTotals = {
    sessionCount: 0,
    runningCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    costAvailable: false,
    costComplete: true,
    costEstimated: false,
  };
  const visited = new Set<string>();
  const visitedArtifactDirs = new Set<string>();

  function visit(artifactDir: string): void {
    const artifactKey = cacheKey(artifactDir);
    if (visitedArtifactDirs.has(artifactKey)) return;
    visitedArtifactDirs.add(artifactKey);

    const linkedActivityFiles = new Set<string>();
    for (const child of Object.values(readNameRegistry(artifactDir))) {
      if (!child || typeof child.sessionFile !== "string") continue;
      const sessionFile = resolve(child.sessionFile);
      const key = cacheKey(sessionFile);
      if (visited.has(key)) continue;
      visited.add(key);
      totals.sessionCount += 1;

      let activityRunning: boolean | undefined;
      if (typeof child.activityFile === "string") {
        const activityFile = resolve(child.activityFile);
        linkedActivityFiles.add(cacheKey(activityFile));
        activityRunning = activityIsRunning(activityFile);
      }
      // The spawner's registry is updated when its watcher observes process exit,
      // so an explicit running flag is authoritative because activity snapshots
      // can lag shutdown.
      if (child.running ?? activityRunning ?? false) totals.runningCount += 1;

      if (typeof child.usageFile === "string") {
        const usage = readClaudeUsageSidecar(resolve(child.usageFile));
        if (usage) {
          totals.inputTokens += usage.inputTokens ?? 0;
          totals.outputTokens += usage.outputTokens ?? 0;
          totals.cacheReadTokens += usage.cacheReadTokens ?? 0;
          totals.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
          if (usage.costAvailable && usage.cost !== null) {
            totals.cost += usage.cost;
            totals.costAvailable = true;
            totals.costEstimated ||= usage.estimated;
          } else {
            totals.costComplete = false;
          }
        } else {
          totals.costComplete = false;
        }
      } else {
        const stats = readCachedStats(sessionFile);
        if (stats) {
          totals.inputTokens += stats.inputTokens;
          totals.outputTokens += stats.outputTokens;
          totals.cacheReadTokens += stats.cacheReadTokens;
          totals.cacheWriteTokens += stats.cacheWriteTokens;
          totals.cost += stats.cost;
          totals.costAvailable ||= stats.costAvailable;
          if (!stats.costAvailable || stats.costComplete === false) totals.costComplete = false;
        } else {
          // No readable transcript or retained usage. Never infer a free run.
          totals.costComplete = false;
        }
      }

      const sessionId = child.sessionId ?? (existsSync(sessionFile) ? getSessionId(sessionFile) : null);
      if (sessionId) {
        visit(join(dirname(sessionFile), "artifacts", sessionId));
      }
    }

    totals.runningCount += countUnlinkedRunningActivityFiles(artifactDir, linkedActivityFiles);
  }

  visit(rootArtifactDir);
  return totals;
}
