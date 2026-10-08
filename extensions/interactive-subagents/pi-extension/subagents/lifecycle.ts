import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

export interface RunMetadata {
  version: 1;
  state: "launching" | "running" | "unknown" | "finished";
  launchConfirmed?: boolean;
  interactive?: boolean;
  parentSessionId: string;
  runId: string;
  herdrAgentName: string;
  surface: string;
  herdrTabId?: string;
  sessionFile: string;
  transcriptOffset: number;
  ownerToken?: string;
  activityFile?: string;
  usageFile?: string;
  askFile?: string;
  pendingFile?: string;
  sentinelFile?: string;
  profile?: string;
  task: string;
  startTime: number;
  cli: "pi" | "claude";
}

interface OwnerRecord {
  version: 1;
  token: string;
  runId: string;
  ownerPid: number;
  herdrAgentName: string;
  surface: string;
  state: "launching" | "running";
}

export function canonicalSessionPath(sessionFile: string): string {
  let path = resolve(sessionFile);
  const missing: string[] = [];
  while (!existsSync(path)) {
    missing.unshift(basename(path));
    const parent = dirname(path);
    if (parent === path) break;
    path = parent;
  }
  const canonical = join(realpathSync.native(path), ...missing);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function ownerPath(sessionFile: string): string {
  return `${canonicalSessionPath(sessionFile)}.subagent-owner`;
}

function readOwner(path: string): OwnerRecord | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data?.version === 1 && typeof data.token === "string" && data.token &&
        typeof data.runId === "string" && data.runId && Number.isInteger(data.ownerPid) && data.ownerPid > 0 &&
        typeof data.herdrAgentName === "string" && typeof data.surface === "string" &&
        (data.state === "launching" || data.state === "running")) return data;
  } catch {}
  return null;
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // Only ESRCH proves absence. Permissions and other errors are unknown/live.
    return error?.code !== "ESRCH";
  }
}

function writeOwner(path: string, owner: OwnerRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temp, `${JSON.stringify(owner)}\n`, { flag: "wx" });
  renameSync(temp, path);
}

/**
 * Acquire exclusive mutation ownership of a child transcript before launch or
 * resume. Existing ownership is never removed here: callers may retry stale
 * recovery only after proving the recorded process is dead and Herdr confirms
 * the child is absent. `canRecoverStale` must be false for incomplete launches.
 */
export function acquireTranscriptOwnership(params: {
  sessionFile: string;
  runId: string;
  herdrAgentName: string;
  surface: string;
  state: "launching" | "running";
  canRecoverStale?: boolean;
  expectedPriorRunId?: string;
  herdrConfirmedAbsent?: boolean;
}): string {
  const path = ownerPath(params.sessionFile);
  const guard = `${path}.guard`;
  mkdirSync(dirname(path), { recursive: true });
  let guardFd: number;
  try {
    guardFd = openSync(guard, "wx", 0o600);
    writeFileSync(guardFd, JSON.stringify({ pid: process.pid }));
  } catch {
    throw new Error(`Transcript ownership is being checked by another process (${path}).`);
  }
  try {
    const current = readOwner(path);
    if (current) {
      if (current.state === "launching" || current.runId !== params.expectedPriorRunId ||
          !params.canRecoverStale || !params.herdrConfirmedAbsent ||
          (processIsAlive(current.ownerPid) && current.ownerPid !== process.pid)) {
        throw new Error(`Transcript is owned by run ${current.runId}; refusing concurrent mutation.`);
      }
      // The caller has already confirmed Herdr absence. Never recover an
      // incomplete launch intent: a delayed Herdr start may still appear.
      unlinkSync(path);
    } else if (existsSync(path)) {
      throw new Error(`Transcript has unreadable ownership metadata (${path}); refusing mutation.`);
    }
    const token = randomUUID();
    const owner: OwnerRecord = {
      version: 1, token, runId: params.runId, ownerPid: process.pid,
      herdrAgentName: params.herdrAgentName, surface: params.surface, state: params.state,
    };
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(owner)}\n`); } finally { closeSync(fd); }
    return token;
  } finally {
    try { closeSync(guardFd); } catch {}
    try { unlinkSync(guard); } catch {}
  }
}

function withOwnerGuard<T>(path: string, action: () => T): T {
  const guard = `${path}.guard`;
  const fd = openSync(guard, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    return action();
  } finally {
    closeSync(fd);
    unlinkSync(guard);
  }
}

export function updateTranscriptOwnership(sessionFile: string, token: string, state: "launching" | "running"): void {
  const path = ownerPath(sessionFile);
  withOwnerGuard(path, () => {
    const current = readOwner(path);
    if (!current || current.token !== token) throw new Error("Transcript ownership token changed.");
    writeOwner(path, { ...current, state });
  });
}

export function releaseTranscriptOwnership(sessionFile: string, token: string): boolean {
  const path = ownerPath(sessionFile);
  return withOwnerGuard(path, () => {
    const current = readOwner(path);
    if (!current || current.token !== token) return false;
    unlinkSync(path);
    return true;
  });
}

/** Test/external reconciliation view; malformed ownership is reported as unknown. */
export function inspectTranscriptOwnership(sessionFile: string): OwnerRecord | "unknown" | null {
  const path = ownerPath(sessionFile);
  if (!existsSync(path)) return null;
  return readOwner(path) ?? "unknown";
}
