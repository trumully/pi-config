import { existsSync, renameSync } from "node:fs";
import { attachCapacity, releaseCapacity, type CapacityTicket } from "./capacity.ts";
import { warnOnce } from "./delivery.ts";
import { acquireTranscriptOwnership, releaseTranscriptOwnership, updateTranscriptOwnership } from "./lifecycle.ts";
import { claimRegisteredRun, restoreRegisteredRun, updateRegisteredRun, type NameRegistryEntry } from "./session.ts";

export type LaunchPhase = "prepared" | "claimed" | "submission-entered" | "confirmed";

export type LaunchOutcome =
  | "rolled-back"
  | "uncertain"
  | "confirmed";

const SIGNAL_SUFFIXES = [".exit", ".ask", ".pending"] as const;
const PERSIST_RETRY_DELAYS_MS = [25, 100, 250];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withRetry<T>(action: () => T): Promise<T> {
  for (const delay of PERSIST_RETRY_DELAYS_MS) {
    try {
      return action();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return action();
}

export interface LaunchRun {
  parentArtifactDir: string;
  name: string;
  runId: string;
  sessionFile: string;
  capacity: CapacityTicket;
  prior: NameRegistryEntry | null;
  closePane: () => void;
}

export class LaunchAttempt {
  phase: LaunchPhase = "prepared";
  ownerToken?: string;
  private archivedSignals: Array<{ path: string; archived: string }> = [];
  private readonly run: LaunchRun;

  constructor(run: LaunchRun) {
    this.run = run;
  }

  acquireOwner(params: Omit<Parameters<typeof acquireTranscriptOwnership>[0], "sessionFile" | "runId">): string {
    this.expect("prepared");
    this.ownerToken = acquireTranscriptOwnership({ ...params, sessionFile: this.run.sessionFile, runId: this.run.runId });
    return this.ownerToken;
  }

  claim(entry: NameRegistryEntry): void {
    this.expect("prepared");
    claimRegisteredRun(this.run.parentArtifactDir, this.run.name, entry, this.run.prior ?? undefined);
    this.phase = "claimed";
  }

  archiveSignals(): void {
    this.expect("claimed");
    for (const suffix of SIGNAL_SUFFIXES) {
      const path = `${this.run.sessionFile}${suffix}`;
      if (!existsSync(path)) continue;
      const archived = `${path}.prior-${this.run.runId}`;
      renameSync(path, archived);
      this.archivedSignals.push({ path, archived });
    }
  }

  async submit(start: () => Promise<void>): Promise<void> {
    this.expect("claimed");
    attachCapacity(this.run.capacity, this.run.parentArtifactDir, this.run.name, this.run.runId);
    this.phase = "submission-entered";
    await start();
    this.phase = "confirmed";
  }

  async recordConfirmed(updates: Partial<NameRegistryEntry>): Promise<void> {
    this.expect("confirmed");
    const { parentArtifactDir, name, runId, sessionFile } = this.run;
    try {
      const updated = await withRetry(() => updateRegisteredRun(parentArtifactDir, name, runId, updates));
      if (!updated) {
        warnOnce(`launch-confirm-registry:${runId}`, `Subagent "${name}" started, but its registry entry now belongs to another run; run ${runId} is tracked in memory only.`);
      }
    } catch (error) {
      warnOnce(`launch-confirm-registry:${runId}`, `Subagent "${name}" started, but its confirmation could not be saved (${messageOf(error)}); the run stays tracked and is reconciled after a reload.`);
    }
    if (!this.ownerToken) return;
    try {
      await withRetry(() => updateTranscriptOwnership(sessionFile, this.ownerToken!, "running"));
    } catch (error) {
      warnOnce(`launch-confirm-owner:${runId}`, `Subagent "${name}" started, but its transcript ownership could not be marked running: ${messageOf(error)}`);
    }
  }

  async abandon(): Promise<LaunchOutcome> {
    if (this.phase === "confirmed") return "confirmed";
    if (this.phase === "submission-entered") return "uncertain";
    const { parentArtifactDir, name, runId, sessionFile, capacity, prior } = this.run;
    for (const { path, archived } of this.archivedSignals) {
      try {
        if (existsSync(archived) && !existsSync(path)) renameSync(archived, path);
      } catch (error) {
        warnOnce(`launch-rollback-signal:${runId}:${path}`, `Could not restore ${path}: ${messageOf(error)}`);
      }
    }
    if (this.phase === "claimed") {
      try {
        await withRetry(() => restoreRegisteredRun(parentArtifactDir, name, runId, prior));
      } catch (error) {
        warnOnce(`launch-rollback-registry:${runId}`, `Could not undo the registry claim for "${name}" (run ${runId} never started): ${messageOf(error)}`);
      }
    }
    if (this.ownerToken) {
      try {
        releaseTranscriptOwnership(sessionFile, this.ownerToken);
      } catch (error) {
        warnOnce(`launch-rollback-owner:${runId}`, `Could not release transcript ownership for "${name}": ${messageOf(error)}`);
      }
    }
    try {
      releaseCapacity(capacity);
    } catch (error) {
      warnOnce(`launch-rollback-capacity:${runId}`, `Could not release the capacity slot for "${name}": ${messageOf(error)}`);
    }
    this.run.closePane();
    return "rolled-back";
  }

  private expect(phase: LaunchPhase): void {
    if (this.phase !== phase) throw new Error(`Launch ${this.run.runId} is ${this.phase}, expected ${phase}.`);
  }
}
