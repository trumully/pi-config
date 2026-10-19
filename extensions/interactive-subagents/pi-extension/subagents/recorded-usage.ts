import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getSessionId, summarizeSessionStats, type SessionStats } from "./session.ts";

const recordPath = (sessionFile: string) => `${sessionFile}.recorded-usage.jsonl`;

/** Retain original usage entries, not a reconstructed price or guessed zero. */
export function persistRecordedUsage(sessionFile: string, excludedIds: ReadonlySet<string>): void {
  let temporary: string | undefined;
  try {
    const entries = readFileSync(sessionFile, "utf8").split("\n")
      .filter((line) => line.trim()).map((line) => JSON.parse(line));
    const header = entries[0];
    if (header?.type !== "session" || typeof header.id !== "string") return;
    // Legacy forks need their parent to identify copied usage. Fail closed
    // rather than recording the parent's bill as the child's.
    if (typeof header.parentSession === "string" && !Array.isArray(header.inheritedEntryIds) &&
        !existsSync(header.parentSession)) return;
    const usageEntries = entries.slice(1).filter((entry) => {
      if (excludedIds.has(entry.id)) return false;
      if (["usage", "branch_summary", "compaction"].includes(entry.type)) return !!entry.usage;
      return entry.type === "message" &&
        ["assistant", "toolResult"].includes(entry.message?.role) && !!entry.message?.usage;
    });
    const hasRecordedCost = usageEntries.some((entry) => {
      const total = (entry.usage ?? entry.message?.usage)?.cost?.total;
      return typeof total === "number" && Number.isFinite(total) && total >= 0;
    });
    if (!hasRecordedCost) return;
    const destination = recordPath(sessionFile);
    temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
    const retainedHeader = {
      type: "session", version: 3, id: header.id,
      recordedUsage: { version: 1, sourceSessionFile: resolve(sessionFile) },
    };
    const records = usageEntries.map((entry) => ({
      type: "usage", id: entry.id, sourceEntryType: entry.type,
      usage: entry.usage ?? entry.message?.usage,
    }));
    writeFileSync(temporary, [retainedHeader, ...records].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
    renameSync(temporary, destination);
  } catch {
    // A partial live append or failed write leaves the previous record intact.
  } finally {
    if (temporary) try { unlinkSync(temporary); } catch {}
  }
}

/** A retained record proves only the usage captured so far, never final completeness. */
export function readRecordedUsage(sessionFile: string): SessionStats | null {
  const path = recordPath(sessionFile);
  try {
    const firstLine = readFileSync(path, "utf8").split("\n", 1)[0];
    const header = JSON.parse(firstLine);
    if (header.type !== "session" || typeof header.id !== "string" ||
        header.recordedUsage?.version !== 1 ||
        typeof header.recordedUsage.sourceSessionFile !== "string" ||
        resolve(header.recordedUsage.sourceSessionFile) !== resolve(sessionFile)) return null;
    const currentId = getSessionId(sessionFile);
    if (currentId !== null && currentId !== header.id) return null;
    const stats = summarizeSessionStats(path);
    return stats?.costAvailable ? stats : null;
  } catch {
    return null;
  }
}
