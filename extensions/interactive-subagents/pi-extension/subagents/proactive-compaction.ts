import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PROACTIVE_COMPACTION_THRESHOLD_PERCENT = 70;
export const PROACTIVE_COMPACTION_REARM_HYSTERESIS_PERCENT = 5;

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
const EXAMPLE_CONFIG_PATH = join(PACKAGE_ROOT, "config.json.example");

export interface ProactiveCompactionConfig {
  enabled: boolean;
  thresholdPercent: number;
}

export interface ProactiveCheckpoint {
  goal: string;
  task: string;
  completed: string[];
  inProgress: string;
  decisions: string[];
  verifiedTests: string[];
  nextAction: string;
}

export type ProactiveHandoffPhase =
  | "requested"
  | "compacting"
  | "compacted"
  | "resume-pending"
  | "resumed"
  | "completed"
  | "failed";

export interface ProactiveHandoffState {
  version: 1;
  id: string;
  phase: ProactiveHandoffPhase;
  createdAt: number;
  requestEntryCount: number;
  compactionBaselineEntryCount?: number;
  resumeToken?: string;
  checkpoint: ProactiveCheckpoint;
  error?: string;
  aborted?: boolean;
}

const HANDOFF_PHASES = new Set<ProactiveHandoffPhase>([
  "requested",
  "compacting",
  "compacted",
  "resume-pending",
  "resumed",
  "completed",
  "failed",
]);

export function parseProactiveCompactionConfig(
  raw: unknown,
  source = "config.json",
): ProactiveCompactionConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid proactive compaction config in ${source}: root must be an object`);
  }
  const root = raw as Record<string, unknown>;
  const value = root.proactiveCompaction;
  if (value === undefined) {
    return {
      enabled: true,
      thresholdPercent: DEFAULT_PROACTIVE_COMPACTION_THRESHOLD_PERCENT,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid proactive compaction config in ${source}: proactiveCompaction must be an object`);
  }

  const config = value as Record<string, unknown>;
  const unsupportedKeys = Object.keys(config).filter(
    (key) => key !== "enabled" && key !== "thresholdPercent",
  );
  if (unsupportedKeys.length > 0) {
    throw new Error(
      `Invalid proactive compaction config in ${source}: unsupported key(s): ${unsupportedKeys.join(", ")}`,
    );
  }

  const enabled = config.enabled ?? true;
  if (typeof enabled !== "boolean") {
    throw new Error(`Invalid proactive compaction config in ${source}: enabled must be a boolean`);
  }
  const thresholdPercent = config.thresholdPercent ?? DEFAULT_PROACTIVE_COMPACTION_THRESHOLD_PERCENT;
  if (
    typeof thresholdPercent !== "number" ||
    !Number.isFinite(thresholdPercent) ||
    thresholdPercent < 1 ||
    thresholdPercent > 100
  ) {
    throw new Error(
      `Invalid proactive compaction config in ${source}: thresholdPercent must be between 1 and 100`,
    );
  }

  return { enabled, thresholdPercent };
}

export function loadProactiveCompactionConfig(): ProactiveCompactionConfig {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    raw = readFileSync(EXAMPLE_CONFIG_PATH, "utf8");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in subagent config: ${detail}`);
  }
  return parseProactiveCompactionConfig(parsed, CONFIG_PATH);
}

/** Latch once at threshold; rearm only after usage drops below threshold with hysteresis. */
export function advanceThresholdLatch(
  latched: boolean,
  percent: number | null | undefined,
  thresholdPercent: number,
  hysteresisPercent = PROACTIVE_COMPACTION_REARM_HYSTERESIS_PERCENT,
): { latched: boolean; request: boolean } {
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0) {
    return { latched, request: false };
  }
  if (latched) {
    return percent < thresholdPercent - hysteresisPercent
      ? { latched: false, request: false }
      : { latched: true, request: false };
  }
  return percent >= thresholdPercent
    ? { latched: true, request: true }
    : { latched: false, request: false };
}

export function validateProactiveCheckpoint(value: unknown): ProactiveCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const requiredText = ["goal", "task", "inProgress", "nextAction"] as const;
  for (const field of requiredText) {
    if (typeof source[field] !== "string" || !source[field].trim()) return null;
  }
  const listFields = ["completed", "decisions", "verifiedTests"] as const;
  for (const field of listFields) {
    const list = source[field];
    if (
      !Array.isArray(list) ||
      list.length > 40 ||
      list.some((item) => typeof item !== "string" || item.length > 2_000)
    ) {
      return null;
    }
  }
  const checkpoint = {
    goal: (source.goal as string).trim(),
    task: (source.task as string).trim(),
    completed: (source.completed as string[]).map((item) => item.trim()).filter(Boolean),
    inProgress: (source.inProgress as string).trim(),
    decisions: (source.decisions as string[]).map((item) => item.trim()).filter(Boolean),
    verifiedTests: (source.verifiedTests as string[]).map((item) => item.trim()).filter(Boolean),
    nextAction: (source.nextAction as string).trim(),
  };
  return JSON.stringify(checkpoint).length <= 24_000 ? checkpoint : null;
}

export function handoffSidecarPath(sessionFile: string): string {
  return `${sessionFile}.self-compact.json`;
}

function parseHandoffState(value: unknown): ProactiveHandoffState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (
    object.version !== 1 ||
    typeof object.id !== "string" ||
    !object.id ||
    typeof object.phase !== "string" ||
    !HANDOFF_PHASES.has(object.phase as ProactiveHandoffPhase) ||
    typeof object.createdAt !== "number" ||
    !Number.isFinite(object.createdAt) ||
    typeof object.requestEntryCount !== "number" ||
    !Number.isInteger(object.requestEntryCount) ||
    object.requestEntryCount < 0
  ) {
    return null;
  }
  if (
    object.compactionBaselineEntryCount !== undefined &&
    (typeof object.compactionBaselineEntryCount !== "number" ||
      !Number.isInteger(object.compactionBaselineEntryCount) ||
      object.compactionBaselineEntryCount < 0)
  ) {
    return null;
  }
  if (object.resumeToken !== undefined && typeof object.resumeToken !== "string") return null;
  if (object.error !== undefined && typeof object.error !== "string") return null;
  if (object.aborted !== undefined && typeof object.aborted !== "boolean") return null;
  const checkpoint = validateProactiveCheckpoint(object.checkpoint);
  if (!checkpoint) return null;
  return { ...object, checkpoint } as ProactiveHandoffState;
}

export function readHandoffState(sessionFile: string): ProactiveHandoffState | null {
  try {
    return parseHandoffState(JSON.parse(readFileSync(handoffSidecarPath(sessionFile), "utf8")));
  } catch {
    return null;
  }
}

export function handoffSidecarExists(sessionFile: string): boolean {
  return existsSync(handoffSidecarPath(sessionFile));
}

/** Persist state before any asynchronous compaction or continuation is scheduled. */
export function writeHandoffState(sessionFile: string, state: ProactiveHandoffState): void {
  const path = handoffSidecarPath(sessionFile);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const tempPath = `${path}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(state)}\n`, "utf8");
    renameSync(tempPath, path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup; preserve the original write error.
    }
    throw error;
  }
}

export function handoffNeedsToStayOpen(state: ProactiveHandoffState | null): boolean {
  return !!state && ["requested", "compacting", "compacted", "resume-pending"].includes(state.phase);
}

export function branchHasCompactionAfter(
  branch: readonly { type?: unknown }[],
  entryCount: number,
): boolean {
  return branch.slice(Math.max(0, entryCount)).some((entry) => entry.type === "compaction");
}

export function branchHasResumeToken(
  branch: readonly any[],
  token: string | undefined,
): boolean {
  if (!token) return false;
  return branch.some((entry) => {
    if (entry.type !== "message" || entry.message?.role !== "user") return false;
    const content = entry.message.content;
    if (typeof content === "string") return content.includes(token);
    return Array.isArray(content) && content.some(
      (part: any) => part?.type === "text" && typeof part.text === "string" && part.text.includes(token),
    );
  });
}

export function branchHasAssistantAfterResumeToken(
  branch: readonly any[],
  token: string | undefined,
): boolean {
  if (!token) return false;
  const resumeIndex = branch.findIndex((entry) => {
    if (entry.type !== "message" || entry.message?.role !== "user") return false;
    const content = entry.message.content;
    if (typeof content === "string") return content.includes(token);
    return Array.isArray(content) && content.some(
      (part: any) => part?.type === "text" && typeof part.text === "string" && part.text.includes(token),
    );
  });
  return resumeIndex >= 0 && branch.slice(resumeIndex + 1).some(
    (entry) => entry.type === "message" && entry.message?.role === "assistant" &&
      entry.message.stopReason !== "aborted",
  );
}

/** Parent watchers must not publish checkpoint text as a completed task result. */
export function handoffBlocksResultDelivery(state: ProactiveHandoffState | null): boolean {
  return state !== null && state.phase !== "completed";
}

export function formatCheckpoint(checkpoint: ProactiveCheckpoint): string {
  const list = (items: string[]) => items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None recorded";
  return [
    `## Goal\n${checkpoint.goal}`,
    `## Task\n${checkpoint.task}`,
    `## Completed work\n${list(checkpoint.completed)}`,
    `## In progress\n${checkpoint.inProgress}`,
    `## Decisions\n${list(checkpoint.decisions)}`,
    `## Verified tests\n${list(checkpoint.verifiedTests)}`,
    `## Precise next action\n${checkpoint.nextAction}`,
  ].join("\n\n");
}
