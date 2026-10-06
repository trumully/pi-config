import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { readSubagentActivityFile } from "./activity.ts";
import { readClaudeUsageSidecar } from "./claude-usage.ts";
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

    const stats = summarizeSessionStats(sessionFile, {
      excludeEntryIds: getInheritedSessionEntryIds(sessionFile),
    });
    if (!stats) return cached?.stats ?? null;

    sessionStatsCache.set(key, { size: file.size, mtimeMs: file.mtimeMs, stats });
    return stats;
  } catch {
    return null;
  }
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
      } else if (existsSync(sessionFile)) {
        const stats = readCachedStats(sessionFile);
        if (stats) {
          totals.inputTokens += stats.inputTokens;
          totals.outputTokens += stats.outputTokens;
          totals.cacheReadTokens += stats.cacheReadTokens;
          totals.cacheWriteTokens += stats.cacheWriteTokens;
          totals.cost += stats.cost;
          totals.costAvailable ||= stats.costAvailable;
          if (!stats.costAvailable) totals.costComplete = false;
        } else {
          totals.costComplete = false;
        }
      } else {
        // A registered child without a transcript or usage sidecar has unknown
        // cost, including while it is still running.
        totals.costComplete = false;
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
