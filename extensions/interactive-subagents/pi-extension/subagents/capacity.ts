import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { processIsAlive } from "./lifecycle.ts";
import { getRunningAgentSurface } from "./herdr.ts";
import { readNameRegistry } from "./session.ts";

export const DEFAULT_MAX_CONCURRENT = 4;
export const CAPACITY_SCOPE_ENV = "PI_SUBAGENT_CAPACITY_SCOPE";
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

export interface CapacityTicket { scope: string; id: string }
interface Slot {
  version: 1;
  id: string;
  ownerPid: number;
  parentArtifactDir?: string;
  name?: string;
  runId?: string;
}

export function parseCapacityLimit(raw: unknown): number {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Subagent config must be an object");
  const limits = (raw as Record<string, unknown>).limits;
  if (limits === undefined) return DEFAULT_MAX_CONCURRENT;
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) throw new Error("limits must be an object");
  if (Object.keys(limits).some((key) => key !== "maxConcurrent")) throw new Error("Unsupported subagent limits key");
  const maximum = (limits as Record<string, unknown>).maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  if (typeof maximum !== "number" || !Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error("limits.maxConcurrent must be a positive integer");
  }
  return maximum;
}

export function loadCapacityLimit(): number {
  const configured = join(PACKAGE_ROOT, "config.json");
  const path = existsSync(configured) ? configured : join(PACKAGE_ROOT, "config.json.example");
  return parseCapacityLimit(JSON.parse(readFileSync(path, "utf8")));
}

function pathFor(ticket: CapacityTicket): string {
  if (!/^[a-z0-9-]+$/.test(ticket.id)) throw new Error("Invalid subagent capacity ticket");
  return join(ticket.scope, `${ticket.id}.slot.json`);
}

function writeAtomic(path: string, data: unknown): void {
  const temp = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temp, JSON.stringify(data), { flag: "wx", mode: 0o600 });
  renameSync(temp, path);
}

function withGuard<T>(scope: string, action: () => T): T {
  mkdirSync(scope, { recursive: true });
  const guard = join(scope, "capacity.guard");
  let fd: number;
  try { fd = openSync(guard, "wx", 0o600); }
  catch { throw new Error("Subagent capacity is locked by another process; retry after it finishes or inspect a stale capacity.guard."); }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    return action();
  } finally {
    closeSync(fd);
    unlinkSync(guard);
  }
}

function slots(scope: string): Slot[] {
  if (!existsSync(scope)) return [];
  return readdirSync(scope).filter((name) => name.endsWith(".slot.json")).map((name) => {
    const raw = JSON.parse(readFileSync(join(scope, name), "utf8"));
    if (raw?.version !== 1 || typeof raw.id !== "string" || !Number.isInteger(raw.ownerPid) || raw.ownerPid < 1) {
      throw new Error(`Unreadable subagent capacity slot ${name}; refusing new launches`);
    }
    return raw as Slot;
  });
}

/** The root writes the shared limit; nested children only inherit its scope. */
export function capacityScope(parentArtifactDir: string, maximum: number): string {
  const inherited = process.env[CAPACITY_SCOPE_ENV];
  if (inherited) return inherited;
  const scope = join(parentArtifactDir, "subagent-capacity");
  withGuard(scope, () => {
    writeAtomic(join(scope, "limit.json"), { maxConcurrent: maximum });
    // Existing runs count too, including legacy/unknown records. Import before
    // admitting a new launch rather than racing asynchronous watcher recovery.
    for (const [name, entry] of Object.entries(readNameRegistry(parentArtifactDir))) {
      if (!entry.running) continue;
      restoreSlot(scope, parentArtifactDir, name, entry.runId);
    }
  });
  return scope;
}

function restoredId(parentArtifactDir: string, name: string, runId?: string): string {
  return createHash("sha256").update(JSON.stringify([parentArtifactDir, name, runId])).digest("hex");
}

function restoreSlot(scope: string, parentArtifactDir: string, name: string, runId?: string): CapacityTicket {
  const ticket = { scope, id: restoredId(parentArtifactDir, name, runId) };
  const entry = readNameRegistry(parentArtifactDir)[name];
  if (entry?.runMetadata?.capacity) {
    const current = entry.runMetadata.capacity;
    if (current.scope === scope && !existsSync(pathFor(current))) writeAtomic(pathFor(current), {
      version: 1, id: current.id, ownerPid: process.pid, parentArtifactDir, name, runId,
    } satisfies Slot);
    return current;
  }
  if (!existsSync(pathFor(ticket))) writeFileSync(pathFor(ticket), JSON.stringify({
    version: 1, id: ticket.id, ownerPid: process.pid, parentArtifactDir, name, runId,
  } satisfies Slot), { flag: "wx", mode: 0o600 });
  return ticket;
}

export function restoreCapacity(parentArtifactDir: string, name: string, runId: string, maximum: number): CapacityTicket {
  const scope = capacityScope(parentArtifactDir, maximum);
  return withGuard(scope, () => restoreSlot(scope, parentArtifactDir, name, runId));
}

function maximumFor(scope: string): number {
  const value = JSON.parse(readFileSync(join(scope, "limit.json"), "utf8")).maxConcurrent;
  if (typeof value !== "number") throw new Error("Unreadable shared concurrency limit; refusing new launches");
  return parseCapacityLimit({ limits: { maxConcurrent: value } });
}

/** Only proven-ended runs or never-submitted reservations may be reclaimed. */
async function reclaimEnded(scope: string): Promise<void> {
  for (const slot of slots(scope)) {
    const ticket = { scope, id: slot.id };
    if (!slot.parentArtifactDir || !slot.name) {
      if (!processIsAlive(slot.ownerPid)) releaseCapacity(ticket);
      continue;
    }
    const entry = readNameRegistry(slot.parentArtifactDir)[slot.name];
    if (!entry || entry.runId !== slot.runId) continue;
    if (entry.running === false) { releaseCapacity(ticket); continue; }
    const run = entry.runMetadata;
    if (!run || (run.state !== "running" && !run.launchConfirmed)) continue;
    if (run.state === "running" && processIsAlive(slot.ownerPid)) continue;
    try {
      if (!await getRunningAgentSurface(run.herdrAgentName, { surface: run.surface, sessionFile: run.sessionFile })) {
        releaseCapacity(ticket);
      }
    } catch { /* Unknown liveness continues to consume capacity. */ }
  }
}

export async function reserveCapacity(scope: string): Promise<CapacityTicket> {
  // Avoid Herdr calls on the normal path. Reconcile stale occupancy only when full.
  if (slots(scope).length >= maximumFor(scope)) await reclaimEnded(scope);
  return withGuard(scope, () => {
    const maximum = maximumFor(scope);
    const count = slots(scope).length;
    if (count >= maximum) {
      throw new Error(`Subagent concurrency limit reached (${count}/${maximum}). Wait for a child to exit; starting, resumed and uncertain children count too.`);
    }
    const ticket = { scope, id: randomUUID() };
    writeFileSync(pathFor(ticket), JSON.stringify({ version: 1, id: ticket.id, ownerPid: process.pid } satisfies Slot), { flag: "wx", mode: 0o600 });
    return ticket;
  });
}

/** Persist the run link before calling Herdr. From here, launch failure is uncertain. */
export function attachCapacity(ticket: CapacityTicket, parentArtifactDir: string, name: string, runId: string): void {
  // Guarded reads ignore concurrent removal; the parent's live reservation may
  // not be reclaimed while its PID is alive and no launch was submitted yet.
  withGuard(ticket.scope, () => {
    if (!existsSync(pathFor(ticket))) throw new Error("Subagent launch reservation disappeared");
    writeAtomic(pathFor(ticket), { version: 1, id: ticket.id, ownerPid: process.pid, parentArtifactDir, name, runId } satisfies Slot);
  });
}

export function releaseCapacity(ticket: CapacityTicket): void {
  try { unlinkSync(pathFor(ticket)); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
}

export function releasePriorCapacity(scope: string, parentArtifactDir: string, name: string, runId?: string, prior?: CapacityTicket): void {
  releaseCapacity(prior ?? { scope, id: restoredId(parentArtifactDir, name, runId) });
}

export function releaseUnsubmittedCapacity(ticket: CapacityTicket): void {
  if (!existsSync(pathFor(ticket))) return;
  const slot = JSON.parse(readFileSync(pathFor(ticket), "utf8")) as Slot;
  if (!slot.parentArtifactDir) releaseCapacity(ticket);
}
