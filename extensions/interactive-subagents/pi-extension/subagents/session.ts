import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { RunMetadata } from "./lifecycle.ts";
import { processIsAlive } from "./lifecycle.ts";

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string;
  [key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
}

export type SeededSubagentSessionMode = "lineage-only" | "fork";

function getForkContentLines(parentSessionFile: string): string[] {
  const raw = readFileSync(parentSessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());

  let truncateAt = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === "message" && entry.message?.role === "user") {
        truncateAt = i;
        break;
      }
    } catch {
      // ignore malformed lines
    }
  }

  return lines.slice(0, truncateAt).filter((line) => {
    try {
      return JSON.parse(line).type !== "session";
    } catch {
      return true;
    }
  });
}

export function seedSubagentSessionFile(params: {
  mode: SeededSubagentSessionMode;
  parentSessionFile: string;
  childSessionFile: string;
  childCwd: string;
}): void {
  const header = {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: params.childCwd,
    parentSession: params.parentSessionFile,
  };
  const contentLines =
    params.mode === "fork" ? getForkContentLines(params.parentSessionFile) : [];
  const lines = [JSON.stringify(header), ...contentLines];

  mkdirSync(dirname(params.childSessionFile), { recursive: true });
  writeFileSync(params.childSessionFile, lines.join("\n") + "\n", "utf8");
}

/**
 * A snapshot of everything needed to reconstruct a subagent's sandbox when its
 * session is later resumed via `subagent_message({ sessionId })`.
 *
 * Written next to the session file as `<sessionFile>.loadout.json` at spawn
 * time. Resume replays this exact snapshot so the reincarnated process gets the
 * same `--no-extensions` + `--tools` restriction, model, identity, spawn
 * whitelist, cwd, and config dir it originally ran with - instead of falling
 * back to pi's default (all global extensions + full toolset). Storing the
 * resolved loadout (rather than re-deriving from the agent `.md` by name) keeps
 * resume faithful even if the agent definition is later edited, moved, or
 * deleted.
 */
export interface SubagentLoadout {
  /** Agent profile name (for PI_SUBAGENT_AGENT); null for agentless spawns. */
  agent: string | null;
  /** The `--tools` allowlist string, or null when the spawn was unrestricted. */
  toolAllowlist: string | null;
  /** Model id (without thinking suffix), or null to use the session default. */
  model: string | null;
  /** Thinking level appended to the model as `model:level`, or null. */
  thinking: string | null;
  /** How the identity text was applied: append/replace, or null. */
  systemPromptMode: "append" | "replace" | null;
  /** The system-prompt/identity text, only when it lived in the system prompt. */
  identity: string | null;
  /** Agents this subagent was allowed to spawn (for PI_SUBAGENT_ALLOWED). */
  spawnable: string[] | null;
  /** Whether the agent auto-exits (informational; resume forces autonomous). */
  autoExit: boolean;
  /** Working directory the subagent ran in, or null. */
  cwd: string | null;
  /** PI_CODING_AGENT_DIR the subagent resolved config/extensions from, or null. */
  agentDir: string | null;
}

/** Path of the loadout sidecar written next to a subagent session file. */
export function loadoutSidecarPath(sessionFile: string): string {
  return `${sessionFile}.loadout.json`;
}

/** Persist a subagent's resolved sandbox loadout beside its session file. */
export function writeSubagentLoadout(sessionFile: string, loadout: SubagentLoadout): void {
  try {
    writeFileSync(loadoutSidecarPath(sessionFile), JSON.stringify(loadout), "utf8");
  } catch {
    // Best-effort: a missing snapshot only means resume will refuse, never that
    // it launches unrestricted.
  }
}

/** Read a subagent's loadout snapshot, or null if absent/unparseable. */
export function readSubagentLoadout(sessionFile: string): SubagentLoadout | null {
  try {
    const p = loadoutSidecarPath(sessionFile);
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as SubagentLoadout;
  } catch {
    return null;
  }
}

// ── Name registry ────────────────────────────────────────────────────────────
// Each spawner session (the top-level pi session, or a worker that spawns its
// own children) gets a registry mapping a subagent's display name to the
// session file it ran in. Names are unique per spawner session and persist on
// disk, so `subagent_message({ name })` can steer a running subagent or resume
// a finished one by the same handle - even across a pi restart. The registry
// lives in the spawner's own artifact dir, which is directly addressable from
// the spawner's session id (no sessions-tree scan, so resume stays fast).

export interface NameRegistryEntry {
  /** Absolute path to the subagent's session .jsonl file. */
  sessionFile: string;
  /** Canonical session header id (kept for display/lineage). */
  sessionId: string | null;
  /** Activity snapshot path for Pi children; absent for older records and Claude CLI children. */
  activityFile?: string;
  /** Final usage sidecar path for Claude CLI children. */
  usageFile?: string;
  /** Spawner-observed process state; authoritative when present because activity snapshots can lag shutdown. */
  running?: boolean;
  /** Identity of the specific spawn/resume run; absent in older registry records. */
  runId?: string;
  /** Current task brief; absent for legacy registry records. */
  taskBrief?: string;
  /** Versioned watcher reconstruction data; legacy records remain readable. */
  runMetadata?: RunMetadata;
}

export type NameRegistry = Record<string, NameRegistryEntry>;

/** Path of the name registry for a given spawner session's artifact dir. */
export function nameRegistryPath(artifactDir: string): string {
  return join(artifactDir, "subagent-registry.json");
}

/** Read a spawner session's name registry, or {} if absent/corrupt. */
export function readNameRegistry(artifactDir: string): NameRegistry {
  try {
    const p = nameRegistryPath(artifactDir);
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as NameRegistry;
  } catch {
    return {};
  }
}

/**
 * Register (or overwrite) a name → session mapping for a spawner session.
 * Writes atomically (temp file + rename) so a concurrent reader never sees a
 * partial registry.
 */
function mutateRegisteredName(
  artifactDir: string,
  name: string,
  mutate: (entry: NameRegistryEntry | null) => NameRegistryEntry | null,
): NameRegistryEntry | null {
  mkdirSync(artifactDir, { recursive: true });
  const p = nameRegistryPath(artifactDir);
  const lock = `${p}.lock`;
  const guard = `${lock}.guard`;
  let guardFd: number;
  try {
    guardFd = openSync(guard, "wx", 0o600);
    writeFileSync(guardFd, `${JSON.stringify({ pid: process.pid })}\n`);
  } catch {
    throw new Error(`Subagent registry is locked by another writer (${lock}).`);
  }
  let lockFd: number | undefined;
  let ownsLock = false;
  try {
    if (existsSync(lock)) {
      let ownerPid: number | undefined;
      try { ownerPid = JSON.parse(readFileSync(lock, "utf8")).pid; } catch {}
      if (!Number.isInteger(ownerPid)) throw new Error(`Subagent registry lock is unreadable (${lock}).`);
      if (processIsAlive(ownerPid!)) throw new Error(`Subagent registry is locked by process ${ownerPid}.`);
      unlinkSync(lock);
    }
    lockFd = openSync(lock, "wx", 0o600);
    ownsLock = true;
    writeFileSync(lockFd, `${JSON.stringify({ pid: process.pid })}\n`);
    const registry = readNameRegistry(artifactDir);
    const entry = mutate(registry[name] ?? null);
    if (!entry) return null;
    registry[name] = entry;
    const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf8");
    renameSync(tmp, p);
    return entry;
  } finally {
    if (lockFd !== undefined) closeSync(lockFd);
    if (ownsLock) try { unlinkSync(lock); } catch {}
    try { closeSync(guardFd); } catch {}
    try { unlinkSync(guard); } catch {}
  }
}

export function registerName(artifactDir: string, name: string, entry: NameRegistryEntry): void {
  mutateRegisteredName(artifactDir, name, () => entry);
}

/** Claim a new name or replace exactly the run inspected before acquiring ownership. */
export function claimRegisteredRun(
  artifactDir: string, name: string, entry: NameRegistryEntry, prior?: NameRegistryEntry,
): void {
  mutateRegisteredName(artifactDir, name, (current) => {
    if (prior ? !current || current.runId !== prior.runId || current.sessionFile !== prior.sessionFile : !!current) {
      throw new Error(`Subagent registry changed for "${name}"; refusing to replace another run.`);
    }
    return entry;
  });
}

export function updateRegisteredRun(
  artifactDir: string, name: string, runId: string, updates: Partial<NameRegistryEntry>,
): boolean {
  return !!mutateRegisteredName(artifactDir, name, (current) =>
    current?.runId === runId ? { ...current, ...updates } : null,
  );
}

/** Check ownership and persist terminal state within the same registry lock. */
export function finishRegisteredRun(artifactDir: string, name: string, runId: string): boolean {
  return !!mutateRegisteredName(artifactDir, name, (current) => {
    if (current?.runId !== runId) return null;
    return {
      ...current, running: false,
      ...(current.runMetadata ? { runMetadata: { ...current.runMetadata, state: "finished" as const } } : {}),
    };
  });
}

/** Resolve a name to its registry entry within a spawner session, or null. */
export function resolveNameInRegistry(
  artifactDir: string,
  name: string,
): NameRegistryEntry | null {
  const entry = readNameRegistry(artifactDir)[name];
  return entry && typeof entry.sessionFile === "string" ? entry : null;
}

function readEntries(sessionFile: string): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Read only the first line of a file without loading the whole thing into
 * memory. Session files grow to many MB, but the header we need is always the
 * first JSON line, so reading a small prefix keeps header lookups cheap.
 * Returns the first line (sans trailing newline), or null.
 */
function readFirstLine(path: string, maxBytes = 65536): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytes = readSync(fd, buf, 0, maxBytes, 0);
    if (bytes <= 0) return null;
    const nl = buf.indexOf(0x0a); // '\n'
    const end = nl === -1 || nl >= bytes ? bytes : nl;
    return buf.toString("utf8", 0, end);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Read the canonical session id from the header. Pi resolves `--session <id>`
 * against this id, not the filename.
 */
export function getSessionId(sessionFile: string): string | null {
  const firstLine = readFirstLine(sessionFile)?.trim();
  if (!firstLine) return null;
  try {
    const entry = JSON.parse(firstLine) as { type?: string; id?: string };
    return entry.type === "session" && typeof entry.id === "string" ? entry.id : null;
  } catch {
    return null;
  }
}

/**
 * IDs of entries copied from a parent session when this subagent was forked.
 * Subtracting these from usage totals avoids billing the parent's prior work a
 * second time when the footer aggregates parent and child sessions.
 */
export function getInheritedSessionEntryIds(sessionFile: string): Set<string> {
  const firstLine = readFirstLine(sessionFile)?.trim();
  if (!firstLine) return new Set();

  let parentSessionFile: string | undefined;
  try {
    const header = JSON.parse(firstLine) as { parentSession?: unknown };
    if (typeof header.parentSession === "string") parentSessionFile = header.parentSession;
  } catch {
    return new Set();
  }
  if (!parentSessionFile) return new Set();

  const ids = new Set<string>();
  try {
    for (const line of readFileSync(parentSessionFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { id?: unknown };
        if (typeof entry.id === "string") ids.add(entry.id);
      } catch {
        // Ignore a partial trailing line while the parent session is active.
      }
    }
  } catch {
    // The parent transcript may no longer be available. Keep the child's own
    // usage visible rather than failing the entire aggregate.
  }
  return ids;
}

/**
 * Count the number of entry lines in a session file without parsing each line
 * into an object. Used by the resume path, which only needs the *count* of
 * pre-existing entries (so it can later slice out the new ones). Parsing every
 * line of a large resumed transcript synchronously at resume time would block
 * the UI; counting newlines is dramatically cheaper.
 */
export function countSessionEntryLines(sessionFile: string): number {
  try {
    const raw = readFileSync(sessionFile, "utf8");
    // Count non-blank lines, mirroring getNewEntries' `.filter(line => line.trim())`
    // but skipping the per-line JSON.parse that makes resume slow on big files.
    let count = 0;
    for (const line of raw.split("\n")) {
      if (line.trim()) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  return lines.slice(afterLine).map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Find the last assistant message text in a list of entries.
 *
 * Falls back to the `errorMessage` field when the last assistant message has
 * `stopReason: "error"` and no usable text content - this happens when
 * auto-retry exhausts on a provider overload / rate limit / server error, and
 * without this fallback the parent would silently see a stale earlier message.
 */
export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;

    const texts = msg.message.content
      .filter(
        (block) =>
          block.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
      )
      .map((block) => block.text as string);

    if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");

    const stopReason = (msg.message as { stopReason?: unknown }).stopReason;
    const errorMessage = (msg.message as { errorMessage?: unknown }).errorMessage;
    if (
      stopReason === "error" &&
      typeof errorMessage === "string" &&
      errorMessage.trim() !== ""
    ) {
      return `Subagent error: ${errorMessage.trim()}`;
    }
  }
  return null;
}

export interface SessionStats {
  model: string | null;
  toolCount: number;
  /** Cumulative token usage across all assistant turns. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Current context size: the last assistant turn's totalTokens. */
  contextTokens: number;
  /** Cumulative cost in USD across all assistant turns. */
  cost: number;
  /** True when input/output token counts were present in this session/run. */
  usageAvailable: boolean;
  inputAvailable: boolean;
  outputAvailable: boolean;
  /** True when at least one usage record supplied a cost. */
  costAvailable: boolean;
  /** Actual compaction entries in the summarized session/run. */
  compactionCount: number;
}

/**
 * Parse a subagent session JSONL into aggregate stats for display: model,
 * tool-call count, cumulative token usage + cost, and current context size.
 * Cumulative usage fields are summed across every assistant
 * turn; the context size is taken from the last assistant turn's `totalTokens`
 * (the live context window occupancy). Returns null if the file can't be read.
 */
export function summarizeSessionStats(
  sessionFile: string,
  options: { excludeEntryIds?: ReadonlySet<string>; afterEntryCount?: number } = {},
): SessionStats | null {
  let entries: SessionEntry[];
  try {
    entries = readEntries(sessionFile);
  } catch {
    return null;
  }

  const stats: SessionStats = {
    model: null,
    toolCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: 0,
    cost: 0,
    usageAvailable: false,
    inputAvailable: false,
    outputAvailable: false,
    costAvailable: false,
    compactionCount: 0,
  };

  const addUsage = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const usage = value as Record<string, unknown>;
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    if (typeof usage.input === "number" && Number.isFinite(usage.input)) stats.inputAvailable = true;
    if (typeof usage.output === "number" && Number.isFinite(usage.output)) stats.outputAvailable = true;
    stats.usageAvailable ||= stats.inputAvailable || stats.outputAvailable;
    stats.inputTokens += num(usage.input);
    stats.outputTokens += num(usage.output);
    stats.cacheReadTokens += num(usage.cacheRead);
    stats.cacheWriteTokens += num(usage.cacheWrite);
    const cost = usage.cost;
    if (cost && typeof cost === "object") {
      const total = (cost as Record<string, unknown>).total;
      if (typeof total === "number" && Number.isFinite(total)) stats.costAvailable = true;
      stats.cost += num(total);
    }
  };

  for (const [entryIndex, entry] of entries.entries()) {
    if (entryIndex < (options.afterEntryCount ?? 0)) continue;
    if (options.excludeEntryIds?.has(entry.id)) continue;
    if (entry.type === "compaction") stats.compactionCount++;
    if (entry.type === "model_change") {
      const modelId = (entry as { modelId?: unknown }).modelId;
      if (typeof modelId === "string" && modelId) stats.model = modelId;
      continue;
    }
    if (entry.type === "usage" || entry.type === "branch_summary" || entry.type === "compaction") {
      addUsage(entry.usage);
      continue;
    }
    if (entry.type !== "message") continue;
    const msg = (entry as MessageEntry).message as MessageEntry["message"] & {
      model?: unknown;
      usage?: Record<string, unknown>;
    };

    if (msg.role === "assistant") {
      if (typeof msg.model === "string" && msg.model) stats.model = msg.model;
      for (const block of msg.content) {
        if (block.type === "toolCall") stats.toolCount++;
      }
      addUsage(msg.usage);
      const total = msg.usage?.totalTokens;
      if (typeof total === "number" && Number.isFinite(total) && total > 0) {
        stats.contextTokens = total;
      }
    } else if (msg.role === "toolResult") {
      addUsage(msg.usage);
    }
  }

  return stats;
}
