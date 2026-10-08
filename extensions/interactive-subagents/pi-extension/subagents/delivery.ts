/**
 * Durable parent mailbox for subagent completion results and child questions.
 *
 * Every notification is written to disk before it is handed to Pi, under a
 * stable ID that includes the parent session and run ID. Pi's `sendMessage`
 * returns before the message is persisted (a steer is queued while the agent
 * streams, and asynchronous failures are reported only as runtime errors), so
 * a send is never treated as an acknowledgement. An item is acknowledged only
 * when a persisted `custom_message` entry carrying its `deliveryId` is observed
 * in the parent session. Until then it stays pending and is replayed on
 * session start/reload and when the parent settles idle.
 *
 * This gives at-least-once delivery with duplicate suppression, not
 * exactly-once: the transcript append and the mailbox removal are separate
 * writes, so recovery relies on the stable ID check rather than atomicity.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DeliveryItem {
  /** Stable identity: `<parentSessionId>:<runId>:<kind>[:<suffix>]`. */
  id: string;
  customType: string;
  content: string;
  details: Record<string, unknown>;
  createdAt: number;
}

/** Replaceable persistence seam. `put` must be durable and idempotent. */
export interface DeliveryStore {
  /** Returns false when an item with this ID is already stored. Throws on write failure. */
  put(item: DeliveryItem): boolean;
  list(): DeliveryItem[];
  remove(id: string): void;
}

const MAILBOX_VERSION = 1;

function fileNameFor(id: string): string {
  return `${createHash("sha256").update(id).digest("hex").slice(0, 32)}.json`;
}

/** One JSON file per item, written atomically with a temp file and rename. */
export function createFileDeliveryStore(dir: string): DeliveryStore {
  return {
    put(item) {
      const path = join(dir, fileNameFor(item.id));
      if (existsSync(path)) return false;
      mkdirSync(dir, { recursive: true });
      const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(temp, `${JSON.stringify({ version: MAILBOX_VERSION, ...item })}\n`, "utf8");
      renameSync(temp, path);
      return true;
    },
    list() {
      if (!existsSync(dir)) return [];
      const items: DeliveryItem[] = [];
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        const path = join(dir, file);
        try {
          const data = JSON.parse(readFileSync(path, "utf8"));
          if (typeof data?.id !== "string" || typeof data?.customType !== "string" || typeof data?.content !== "string") {
            throw new Error("missing id, customType, or content");
          }
          items.push({
            id: data.id,
            customType: data.customType,
            content: data.content,
            details: data.details && typeof data.details === "object" ? data.details : {},
            createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
          });
        } catch (error: any) {
          // Set unreadable items aside once instead of warning on every replay.
          try { renameSync(path, `${path}.corrupt`); } catch {}
          warnOnce(`corrupt:${path}`, `Set aside unreadable mailbox item ${path}: ${error?.message ?? String(error)}`);
        }
      }
      return items.sort((a, b) => a.createdAt - b.createdAt);
    },
    remove(id) {
      try { unlinkSync(join(dir, fileNameFor(id))); } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
    },
  };
}

export function deliveryId(parentSessionId: string, runId: string, kind: string, suffix?: string): string {
  return [parentSessionId, runId, kind, ...(suffix ? [suffix] : [])].join(":");
}

export interface MailboxBinding {
  parentSessionId: string;
  store: DeliveryStore;
  /** Hand a message to Pi. Not an acknowledgement. */
  send(item: DeliveryItem): void;
  /** Persisted session entries of the parent (all branches). */
  getEntries(): readonly any[];
  isIdle(): boolean;
}

/** In a single runtime, re-send an unacknowledged item only after this long idle. */
const RETRY_AFTER_MS = 30_000;

let binding: MailboxBinding | null = null;
/** Items handed to Pi in this runtime and not yet observed as persisted. */
const inFlight = new Map<string, number>();
const acknowledged = new Set<string>();
const warned = new Set<string>();
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function cancelRetry(): void {
  if (retryTimer !== undefined) clearTimeout(retryTimer);
  retryTimer = undefined;
}

/** Retry asynchronous Pi failures even if no later parent turn settles. */
function scheduleRetry(): void {
  if (!binding || retryTimer !== undefined) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    reconcilePersisted();
    replayPending();
  }, RETRY_AFTER_MS);
  retryTimer.unref?.();
}

export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.error(`[interactive-subagents] ${message}`);
}

export function bindMailbox(next: MailboxBinding): void {
  cancelRetry();
  if (binding?.parentSessionId !== next.parentSessionId) {
    inFlight.clear();
    acknowledged.clear();
  }
  binding = next;
}

export function unbindMailbox(): void {
  cancelRetry();
  binding = null;
  inFlight.clear();
  acknowledged.clear();
}

export function currentParentSessionId(): string | null {
  return binding?.parentSessionId ?? null;
}

function persistedDeliveryIds(target: MailboxBinding): Set<string> {
  const ids = new Set<string>();
  for (const entry of target.getEntries()) {
    if (entry?.type !== "custom_message") continue;
    const id = entry.details?.deliveryId;
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}

function acknowledge(target: MailboxBinding, id: string): void {
  try {
    target.store.remove(id);
  } catch (error: any) {
    // Still suppressed: the persisted entry is checked before any resend.
    warnOnce(`remove:${id}`, `Could not remove acknowledged mailbox item ${id}: ${error?.message ?? String(error)}`);
  }
  acknowledged.add(id);
  inFlight.delete(id);
}

function dispatch(target: MailboxBinding, item: DeliveryItem, persisted: Set<string>): void {
  if (persisted.has(item.id)) {
    acknowledge(target, item.id);
    return;
  }
  if (acknowledged.has(item.id) || inFlight.has(item.id)) return;
  inFlight.set(item.id, Date.now());
  try {
    target.send(item);
  } catch (error: any) {
    inFlight.delete(item.id);
    warnOnce(`send:${item.id}`, `Could not hand mailbox item ${item.id} to Pi; it stays pending: ${error?.message ?? String(error)}`);
  }
  scheduleRetry();
}

export type EnqueueResult = "queued" | "duplicate" | "unbound";

/**
 * Durably record an item, then hand it to Pi. Throws when the item could not
 * be recorded so callers can keep their source (for example a `.ask` file).
 */
export function enqueueDelivery(item: Omit<DeliveryItem, "createdAt">): EnqueueResult {
  const target = binding;
  if (!target) return "unbound";
  if (acknowledged.has(item.id)) return "duplicate";
  const full: DeliveryItem = { ...item, details: { ...item.details, deliveryId: item.id }, createdAt: Date.now() };
  const created = target.store.put(full);
  if (!created && inFlight.has(item.id)) return "duplicate";
  const persisted = persistedDeliveryIds(target);
  if (persisted.has(item.id)) {
    acknowledge(target, item.id);
    return "duplicate";
  }
  dispatch(target, full, persisted);
  return created ? "queued" : "duplicate";
}

/** Acknowledge every pending item that already has a persisted transcript entry. */
export function reconcilePersisted(): void {
  const target = binding;
  if (!target) return;
  let items: DeliveryItem[];
  try {
    items = target.store.list();
  } catch (error: any) {
    warnOnce("list", `Could not read the subagent mailbox: ${error?.message ?? String(error)}`);
    return;
  }
  if (items.length === 0) return;
  const persisted = persistedDeliveryIds(target);
  for (const item of items) if (persisted.has(item.id)) acknowledge(target, item.id);
}

/**
 * Replay pending items while the parent is idle. Items sent in this runtime
 * are retried only after RETRY_AFTER_MS without a persisted entry, so a
 * message still queued inside Pi is not sent twice.
 */
export function replayPending(now = Date.now()): void {
  const target = binding;
  if (!target) return;
  if (!target.isIdle()) {
    scheduleRetry();
    return;
  }
  let items: DeliveryItem[];
  try {
    items = target.store.list();
  } catch (error: any) {
    warnOnce("list", `Could not read the subagent mailbox: ${error?.message ?? String(error)}`);
    scheduleRetry();
    return;
  }
  if (items.length === 0) {
    cancelRetry();
    return;
  }
  scheduleRetry();
  const persisted = persistedDeliveryIds(target);
  for (const item of items) {
    const sentAt = inFlight.get(item.id);
    if (sentAt !== undefined && !persisted.has(item.id)) {
      if (now - sentAt < RETRY_AFTER_MS) continue;
      inFlight.delete(item.id);
    }
    dispatch(target, item, persisted);
  }
}

/**
 * Pi emits `message_end` to extensions just before it appends the entry, so
 * check for the persisted entry on the next macrotask.
 */
export function observeMessageEnd(message: any): void {
  if (message?.role !== "custom" || typeof message.details?.deliveryId !== "string") return;
  setTimeout(reconcilePersisted, 0);
}
