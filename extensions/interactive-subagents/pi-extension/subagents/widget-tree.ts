/**
 * Data for the subagent tree widget: the named descendants of each running
 * direct agent, read from the registries their sessions keep on disk.
 *
 * `refresh` does all file reads and runs on the widget timer. `rowsFor` reads
 * only the cache, so render never touches the filesystem. Nothing here writes
 * files.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";
import type { RunMetadata } from "./lifecycle.ts";
import { getSessionId, readNameRegistry, type NameRegistryEntry } from "./session.ts";
import {
  classifyStatus,
  createStatusState,
  observeStatus,
  type StatusIconSet,
  type StatusObservation,
  type SubagentStatusKind,
  type SubagentStatusState,
} from "./status.ts";
import { readRunUsage, type RunUsageSnapshot } from "./usage.ts";
import { displayableProfileIcon, type WidgetRow } from "./widget.ts";

// ── Profile icons ──

/** Nerd Font (Font Awesome) glyphs for the bundled and common profiles. */
export const DEFAULT_PROFILE_ICONS: Readonly<Record<string, string>> = {
  worker: "\u{F0AD}", // wrench
  "cc-worker": "\u{F0AD}",
  scout: "\u{F002}", // search
  "gh-scout": "\u{F09B}", // github
  researcher: "\u{F0AC}", // globe
  writer: "\u{F040}", // pencil
  architect: "\u{F0E8}", // sitemap
  tasker: "\u{F0AE}", // tasks
  reviewer: "\u{F06E}", // eye
  "cc-reviewer": "\u{F06E}",
};

/**
 * Read the `icon:` frontmatter value. One pair of matching quotes is
 * removed. Anything that is not a single safe glyph is dropped.
 */
export function parseProfileIcon(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let icon = value.trim();
  const quoted = icon.match(/^(["'])(.*)\1$/su);
  if (quoted) icon = quoted[2];
  // "nerd" is the most permissive set; the widget re-checks for the active one.
  return displayableProfileIcon(icon, "nerd") || undefined;
}

/**
 * Choose the role glyph for a badge. A custom icon wins when the icon set
 * can draw it; otherwise the built-in default applies under Nerd Fonts.
 */
export function resolveProfileIcon(
  profile: string | undefined,
  customIcon: string | undefined,
  icons: StatusIconSet,
  profileIcons: boolean,
): string | undefined {
  if (!profileIcons) return undefined;
  const custom = displayableProfileIcon(customIcon, icons);
  if (custom) return custom;
  if (icons !== "nerd" || !profile) return undefined;
  return Object.hasOwn(DEFAULT_PROFILE_ICONS, profile) ? DEFAULT_PROFILE_ICONS[profile] : undefined;
}

// ── Shared row helpers ──

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  return activity.activeScope;
}

/** Turn an activity file read into a status observation. */
export function statusObservationFromActivity(read: ActivityReadResult): StatusObservation {
  if (!read.ok) return { snapshot: read.reason, snapshotError: read.error };
  const { activity } = read;
  return {
    snapshot: "present",
    updatedAt: activity.updatedAt,
    sequence: activity.sequence,
    phase: activity.phase,
    active: activity.phase === "active",
    activeScope: activity.activeScope,
    activeSince: activity.activeSince,
    waitingSince: activity.waitingSince,
    latestEvent: activity.latestEvent,
    activityLabel: activityLabel(activity),
  };
}

/** Kind and activity text for a row. With status off, rows show plain "running". */
export function statusRowFields(
  state: SubagentStatusState,
  now: number,
  statusEnabled: boolean,
): { kind: SubagentStatusKind; activity: string | null } {
  if (!statusEnabled) return { kind: "running", activity: null };
  const snapshot = classifyStatus(state, now);
  const activity = snapshot.kind === "active"
    ? snapshot.activityLabel ?? snapshot.activeScope
    : snapshot.statusLabel;
  return { kind: snapshot.kind, activity };
}

/** "MM:SS" since start, or "" when the start time is unknown. */
export function formatElapsedClock(startTime: number | undefined, now: number): string {
  if (typeof startTime !== "number" || !Number.isFinite(startTime) || startTime <= 0) return "";
  const seconds = Math.max(0, Math.floor((now - startTime) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const TREE_GLYPHS = {
  box: { branch: "├─ ", last: "└─ ", pipe: "│  ", blank: "   " },
  ascii: { branch: "|- ", last: "`- ", pipe: "|  ", blank: "   " },
};

/**
 * Connector before a nested row. `lastFlags` holds, for each level from the
 * root's children down to this row, whether that node is its parent's last
 * visible child.
 */
export function buildTreePrefix(lastFlags: readonly boolean[], icons: StatusIconSet): string {
  if (lastFlags.length === 0) return "";
  const glyphs = icons === "ascii" ? TREE_GLYPHS.ascii : TREE_GLYPHS.box;
  const ancestors = lastFlags.slice(0, -1).map((last) => (last ? glyphs.blank : glyphs.pipe));
  return ancestors.join("") + (lastFlags[lastFlags.length - 1] ? glyphs.last : glyphs.branch);
}

// ── Collector ──

/** Deepest descendant level read below a direct agent. */
export const MAX_TREE_DEPTH = 8;
/** Most registry entries examined per refresh, so a huge history stays cheap. */
export const MAX_TREE_ENTRIES = 500;
/** Busy transcripts change every second; parsing them that often is wasteful. */
export const TREE_USAGE_REFRESH_MS = 5000;

/** A running direct agent: the root of one tree. */
export interface TreeRoot {
  id: string;
  sessionFile: string;
  cli?: string;
}

export interface TreeRowOptions {
  icons: StatusIconSet;
  profileIcons: boolean;
  statusEnabled: boolean;
}

/** Cached, per-run state carried across refreshes. */
interface NodeCache {
  statusState: SubagentStatusState;
  usage?: RunUsageSnapshot;
  usageCheckedAt?: number;
}

interface TreeNode {
  key: string;
  name: string;
  profile?: string;
  icon?: string;
  startTime?: number;
  live: boolean;
  /**
   * Whether this agent's watcher can be trusted to clear its children's
   * `running` flags. A row kept visible only by a stale flag is not.
   */
  watching: boolean;
  cache?: NodeCache;
  children: TreeNode[];
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function validString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

type TreeCli = "pi" | "claude" | "unknown";

interface EntryRun {
  /** This run's metadata, only when it is well formed. */
  meta?: RunMetadata;
  /** Which CLI the run uses; "unknown" when this run's metadata is malformed. */
  cli: TreeCli;
}

/**
 * Metadata belongs to this run only when its runId matches the registry's,
 * and is used only when the fields the tree reads are well formed. Metadata
 * from another run is ignored, as in records that predate it.
 */
function entryRun(entry: NameRegistryEntry): EntryRun {
  const claudeRecord = !!entry.claude && typeof entry.claude === "object";
  const fallback: EntryRun = { cli: claudeRecord ? "claude" : "pi" };
  const meta = entry.runMetadata as unknown;
  if (!meta || typeof meta !== "object" || Array.isArray(meta) || !validString(entry.runId)) return fallback;
  const m = meta as Record<string, unknown>;
  if (m.runId !== entry.runId) return fallback;
  const valid = m.version === 1 && (m.cli === "pi" || m.cli === "claude") &&
    typeof m.startTime === "number" && Number.isFinite(m.startTime) && m.startTime > 0 &&
    Number.isInteger(m.transcriptOffset) && (m.transcriptOffset as number) >= 0;
  // Malformed metadata for this run cannot tell which files belong to it.
  return valid ? { meta: meta as RunMetadata, cli: m.cli as "pi" | "claude" } : { cli: "unknown" };
}

function compareNodes(a: TreeNode, b: TreeNode): number {
  const at = a.startTime ?? Number.POSITIVE_INFINITY;
  const bt = b.startTime ?? Number.POSITIVE_INFINITY;
  if (at !== bt) return at < bt ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Keep live nodes and the finished ancestors needed to reach one. */
function pruneFinished(nodes: TreeNode[]): TreeNode[] {
  const kept: TreeNode[] = [];
  for (const node of nodes) {
    node.children = pruneFinished(node.children);
    if (node.live || node.children.length > 0) kept.push(node);
  }
  return kept.sort(compareNodes);
}

export class SubagentTreeCollector {
  private trees = new Map<string, TreeNode[]>();
  private nodeCache = new Map<string, NodeCache>();
  private sessionIds = new Map<string, string>();

  /**
   * Re-read the registries below each root. `selfSessionFile` is the session
   * that owns the roots; it is never shown as a descendant.
   */
  refresh(roots: readonly TreeRoot[], now = Date.now(), selfSessionFile?: string): void {
    const visitedSessions = new Set<string>();
    const visitedArtifactDirs = new Set<string>();
    if (selfSessionFile) visitedSessions.add(pathKey(selfSessionFile));
    for (const root of roots) visitedSessions.add(pathKey(root.sessionFile));

    const seenCacheKeys = new Set<string>();
    const budget = { entries: MAX_TREE_ENTRIES };
    const trees = new Map<string, TreeNode[]>();

    // `spawnerWatching`: whether the agent that owns this registry is known to
    // be running, so its watcher keeps the registry's flags current.
    const collect = (sessionFile: string, sessionId: string | undefined, depth: number, spawnerWatching: boolean): TreeNode[] => {
      if (depth > MAX_TREE_DEPTH) return [];
      const id = sessionId ?? this.sessionIdFor(sessionFile);
      if (!id) return [];
      const artifactDir = join(dirname(sessionFile), "artifacts", id);
      const dirKey = pathKey(artifactDir);
      if (visitedArtifactDirs.has(dirKey)) return [];
      visitedArtifactDirs.add(dirKey);

      const nodes: TreeNode[] = [];
      for (const [name, entry] of Object.entries(readNameRegistry(artifactDir))) {
        if (budget.entries <= 0) break;
        budget.entries -= 1;
        if (!entry || typeof entry !== "object" || !validString(entry.sessionFile)) continue;
        const childSession = resolve(entry.sessionFile);
        const sessionKey = pathKey(childSession);
        // A session seen elsewhere in the tree is a duplicate or a cycle.
        if (visitedSessions.has(sessionKey)) continue;
        visitedSessions.add(sessionKey);

        const run = entryRun(entry);
        const node = this.readNode(artifactDir, dirKey, name, entry, run, spawnerWatching, now, seenCacheKeys);
        // Only Pi children spawn, and only a known Pi run's session is a Pi session.
        if (run.cli === "pi") {
          const childId = validString(entry.sessionId) ? entry.sessionId : undefined;
          node.children = collect(childSession, childId, depth + 1, node.watching);
        }
        nodes.push(node);
      }
      return nodes;
    };

    for (const root of roots) {
      trees.set(root.id, root.cli === "claude" ? [] : pruneFinished(collect(resolve(root.sessionFile), undefined, 1, true)));
    }

    for (const key of this.nodeCache.keys()) {
      if (!seenCacheKeys.has(key)) this.nodeCache.delete(key);
    }
    this.trees = trees;
  }

  /** Rows below one root, in preorder, from cached data only. */
  rowsFor(rootId: string, now: number, options: TreeRowOptions): WidgetRow[] {
    const rows: WidgetRow[] = [];
    const walk = (nodes: TreeNode[], lastFlags: boolean[]) => {
      nodes.forEach((node, index) => {
        const flags = [...lastFlags, index === nodes.length - 1];
        rows.push(this.rowFor(node, flags, now, options));
        walk(node.children, flags);
      });
    };
    walk(this.trees.get(rootId) ?? [], []);
    return rows;
  }

  private rowFor(node: TreeNode, lastFlags: boolean[], now: number, options: TreeRowOptions): WidgetRow {
    const base = {
      profile: node.profile,
      name: node.name,
      profileIcon: resolveProfileIcon(node.profile, node.icon, options.icons, options.profileIcons),
      treePrefix: buildTreePrefix(lastFlags, options.icons),
    };
    // A finished ancestor shows only where a live descendant sits.
    if (!node.live || !node.cache) return { ...base, kind: "finished", activity: null, elapsed: "", usage: null };
    return {
      ...base,
      ...statusRowFields(node.cache.statusState, now, options.statusEnabled),
      elapsed: formatElapsedClock(node.startTime, now),
      usage: node.cache.usage?.usage ?? null,
    };
  }

  private sessionIdFor(sessionFile: string): string | undefined {
    const key = pathKey(sessionFile);
    const cached = this.sessionIds.get(key);
    if (cached) return cached;
    const id = existsSync(sessionFile) ? getSessionId(sessionFile) : null;
    if (id) this.sessionIds.set(key, id);
    return id ?? undefined;
  }

  private readNode(
    artifactDir: string,
    dirKey: string,
    name: string,
    entry: NameRegistryEntry,
    run: EntryRun,
    spawnerWatching: boolean,
    now: number,
    seenCacheKeys: Set<string>,
  ): TreeNode {
    const { meta, cli } = run;
    const runId = validString(entry.runId) ? entry.runId : undefined;
    const startTime = meta?.startTime;
    const node: TreeNode = {
      key: `${dirKey}\0${name}\0${runId ?? ""}`,
      name,
      profile: validString(meta?.profile) ? meta.profile : undefined,
      icon: validString(meta?.icon) ? meta.icon : undefined,
      startTime,
      live: false,
      watching: false,
      children: [],
    };

    // Only a boolean is a spawner observation; anything else is malformed.
    const registryRunning = typeof entry.running === "boolean" ? entry.running : undefined;
    // Older records have no run identity, so their state cannot be checked.
    if (registryRunning === false || !runId) return node;

    let read: ActivityReadResult | undefined;
    if (cli === "pi") {
      const activityFile = validString(entry.activityFile)
        ? entry.activityFile
        : validString(meta?.activityFile)
          ? meta.activityFile
          : getSubagentActivityFile(artifactDir, runId);
      read = readSubagentActivityFile(activityFile, runId);
    }
    // Only this run's own, valid activity record can report it done.
    const activityRunning = read?.ok ? read.activity.phase !== "done" : undefined;
    if (registryRunning === true) {
      // A watching spawner clears `running` when the process exits, so its
      // flag outranks an activity file that may lag shutdown. Without one the
      // flag may be stale: a child whose own activity says done has finished.
      // Missing or unreadable activity, or a Claude child, proves nothing, so
      // the row stays (and may show stalled).
      node.live = spawnerWatching || activityRunning !== false;
    } else {
      node.live = activityRunning ?? false;
    }
    // Visible is not the same as confirmed: a row kept only by a stale flag
    // does not vouch for its own children's flags.
    node.watching = node.live && (spawnerWatching || activityRunning === true);
    if (!node.live) return node;

    seenCacheKeys.add(node.key);
    let cache = this.nodeCache.get(node.key);
    if (!cache) {
      cache = {
        // An unknown CLI is observed as Pi with no snapshots: starting, then stalled.
        statusState: createStatusState({ source: cli === "claude" ? "claude" : "pi", startTimeMs: startTime ?? now }),
      };
      this.nodeCache.set(node.key, cache);
    }
    if (read) cache.statusState = observeStatus(cache.statusState, statusObservationFromActivity(read), now);
    this.refreshUsage(cache, entry, meta, cli, now);
    node.cache = cache;
    return node;
  }

  private refreshUsage(
    cache: NodeCache,
    entry: NameRegistryEntry,
    meta: RunMetadata | undefined,
    cli: TreeCli,
    now: number,
  ): void {
    if (cache.usageCheckedAt !== undefined && now - cache.usageCheckedAt < TREE_USAGE_REFRESH_MS) return;
    cache.usageCheckedAt = now;
    const usageFile = validString(entry.usageFile) ? entry.usageFile : validString(meta?.usageFile) ? meta.usageFile : undefined;
    // An unknown CLI's files cannot be read as either kind.
    if (cli === "unknown") return;
    // A Claude transcript is not a Pi session; without its sidecar, usage is unknown.
    if (cli === "claude" && !usageFile) return;
    // Without this run's metadata the transcript offset is unknown, and
    // counting from zero would bill earlier runs to this one.
    if (cli === "pi" && !meta) return;
    cache.usage = readRunUsage({
      sessionFile: resolve(entry.sessionFile),
      startEntryCount: cli === "claude" ? 0 : meta!.transcriptOffset,
      usageFile,
    }, cache.usage);
  }
}
