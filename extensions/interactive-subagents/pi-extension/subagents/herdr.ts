/**
 * Herdr control layer for subagent panes and agents.
 *
 * Herdr owns pane topology and recognized-agent lifecycle. This module keeps
 * all CLI calls, JSON parsing, and terminal reads in one place so the
 * orchestration code can stay focused on Pi sessions and subagent behavior.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;

interface HerdrEnvelope<T = any> {
  result?: T;
  error?: { code?: string; message?: string };
  [key: string]: any;
}

function herdrBinary(): string {
  return process.env.HERDR_BIN_PATH?.trim() || "herdr";
}

function errorText(error: any): string {
  const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString("utf8") : error?.stderr;
  const stdout = Buffer.isBuffer(error?.stdout) ? error.stdout.toString("utf8") : error?.stdout;
  const detail = String(stderr || stdout || error?.message || error).trim();
  try {
    const parsed = JSON.parse(detail);
    return parsed?.error?.message ?? parsed?.message ?? detail;
  } catch {
    return detail;
  }
}

function runHerdrSync(args: string[], timeout = 15_000): string {
  try {
    return execFileSync(herdrBinary(), args, {
      encoding: "utf8",
      timeout,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
  } catch (error: any) {
    throw new Error(`herdr ${args.join(" ")} failed: ${errorText(error)}`);
  }
}

async function runHerdr(args: string[], timeout = 35_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync(herdrBinary(), args, {
      encoding: "utf8",
      timeout,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
    return stdout;
  } catch (error: any) {
    throw new Error(`herdr ${args.join(" ")} failed: ${errorText(error)}`);
  }
}

function parseResponse<T>(stdout: string, command: string): HerdrEnvelope<T> {
  try {
    return JSON.parse(stdout.trim()) as HerdrEnvelope<T>;
  } catch (error: any) {
    throw new Error(`Could not parse herdr ${command} response: ${error?.message ?? String(error)}`);
  }
}

// ── Availability ──

let commandAvailable: boolean | undefined;

/** True only inside a Herdr pane with a working Herdr CLI on PATH. */
export function isHerdrAvailable(): boolean {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) return false;
  if (commandAvailable !== undefined) return commandAvailable;
  try {
    execFileSync(herdrBinary(), ["--version"], {
      stdio: "ignore",
      timeout: 5_000,
      windowsHide: true,
    });
    commandAvailable = true;
  } catch {
    commandAvailable = false;
  }
  return commandAvailable;
}

export function herdrSetupHint(): string {
  return "Start Pi inside Herdr so HERDR_ENV and HERDR_PANE_ID are available.";
}

function requireHerdr(): void {
  if (!isHerdrAvailable()) {
    throw new Error(`Herdr is required for subagents. ${herdrSetupHint()}`);
  }
}

export function getHerdrIntegrationPath(agentConfigDir: string): string {
  return join(agentConfigDir, "extensions", "herdr-agent-state.ts");
}

// ── Pane topology and terminal primitives ──

export interface SurfaceOptions {
  cwd?: string;
  env?: Record<string, string>;
}

function appendSurfaceOptions(args: string[], options?: SurfaceOptions): void {
  if (options?.cwd) args.push("--cwd", options.cwd);
  for (const [key, value] of Object.entries(options?.env ?? {})) {
    args.push("--env", `${key}=${value}`);
  }
}

export interface PaneSize {
  width: number;
  height: number;
}

export interface NestedSplitPlan {
  direction: "right" | "down";
  ratio: number;
}

const MIN_NESTED_PANE_WIDTH = 60;
const MIN_NESTED_PANE_HEIGHT = 14;
const SPLIT_DIVIDER_SIZE = 1;
const MAX_TAB_LABEL_LENGTH = 60;

export interface SubagentSurface {
  surface: string;
  /** Set when this subagent owns a top-level or overflow tab. */
  tabId?: string;
}

/**
 * Top-level agents get a no-focus tab. Nested agents split their parent's pane
 * only when both resulting panes can stay readable; otherwise they get a tab.
 */
export function createSubagentSurface(name: string, options?: SurfaceOptions): SubagentSurface {
  requireHerdr();
  if (process.env.PI_SUBAGENT_ID) {
    const sourcePane = process.env.HERDR_PANE_ID;
    const split = sourcePane ? nestedSplitForPane(sourcePane) : null;
    if (sourcePane && split) {
      return {
        surface: createSurfaceSplit(split.direction, sourcePane, options, split.ratio),
      };
    }
    // A separate tab keeps the child usable when the parent pane cannot fit a
    // minimum-size split, and remains switchable alongside the parent branch.
    return createTabSurface(name, options);
  }
  return createTabSurface(name, options);
}

/** Create an owned, name-labeled Herdr tab and return its root shell pane. */
export function createTabSurface(name: string, options?: SurfaceOptions): SubagentSurface {
  requireHerdr();
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  if (!workspaceId) throw new Error("Cannot create a subagent tab without HERDR_WORKSPACE_ID.");

  const tabs = parseResponse<{ tabs?: Array<{ label?: string }> }>(
    runHerdrSync(["tab", "list", "--workspace", workspaceId]),
    "tab list",
  );
  const label = uniqueSubagentTabLabel(
    name,
    tabs.result?.tabs?.map((tab) => tab.label ?? "") ?? [],
  );

  const args = ["tab", "create", "--workspace", workspaceId, "--label", label, "--no-focus"];
  appendSurfaceOptions(args, options);

  const response = parseResponse<{
    tab?: { tab_id?: string };
    root_pane?: { pane_id?: string };
  }>(runHerdrSync(args), "tab create");
  const tabId = response.result?.tab?.tab_id;
  const surface = response.result?.root_pane?.pane_id;
  if (typeof tabId !== "string" || !tabId || typeof surface !== "string" || !surface) {
    throw new Error(`herdr tab create returned no tab or root pane ID: ${JSON.stringify(response)}`);
  }
  return { surface, tabId };
}

/** Close a Herdr tab owned by a subagent. */
export function closeSubagentTab(tabId: string): void {
  requireHerdr();
  runHerdrSync(["tab", "close", tabId]);
}

/** Create a Herdr split. Herdr supports right/down split directions. */
export function createSurfaceSplit(
  direction: "right" | "down",
  fromSurface?: string,
  options?: SurfaceOptions,
  ratio?: number,
): string {
  requireHerdr();

  const source = fromSurface ?? process.env.HERDR_PANE_ID;
  if (!source) throw new Error("Cannot split a Herdr pane without HERDR_PANE_ID.");

  const args = ["pane", "split", source, "--direction", direction, "--no-focus"];
  if (ratio !== undefined) {
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
      throw new Error(`Herdr split ratio must be between 0 and 1; received ${ratio}.`);
    }
    args.push("--ratio", String(ratio));
  }
  appendSurfaceOptions(args, options);

  const response = parseResponse<{ pane?: { pane_id?: string } }>(
    runHerdrSync(args),
    "pane split",
  );
  const paneId = response.result?.pane?.pane_id;
  if (typeof paneId !== "string" || !paneId) {
    throw new Error(`herdr pane split returned no pane ID: ${JSON.stringify(response)}`);
  }
  return paneId;
}

/**
 * Pick a split direction only when both resulting panes can remain readable.
 * The source pane gets a right split on wide screens and a down split on
 * compact layouts. Otherwise the child gets its own tab.
 */
export function planNestedSubagentSplit(size: PaneSize): NestedSplitPlan | null {
  const width = Math.floor(size.width);
  const height = Math.floor(size.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  const canSplitRight = width >= 2 * MIN_NESTED_PANE_WIDTH + SPLIT_DIVIDER_SIZE;
  const canSplitDown = height >= 2 * MIN_NESTED_PANE_HEIGHT + SPLIT_DIVIDER_SIZE;
  if (!canSplitRight && !canSplitDown) return null;

  const direction = canSplitRight && canSplitDown
    ? (width >= height * 1.5 ? "right" : "down")
    : canSplitRight
      ? "right"
      : "down";
  return { direction, ratio: 0.5 };
}

/** Return the name alone unless an existing tab already uses it. */
export function uniqueSubagentTabLabel(name: string, existingLabels: string[] = []): string {
  const base = truncateLabel(name.replace(/\s+/g, " ").trim() || "subagent", MAX_TAB_LABEL_LENGTH);
  const used = new Set(existingLabels.map((label) => label.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;

  for (let suffixNumber = 2; ; suffixNumber++) {
    const suffix = ` (${suffixNumber})`;
    const candidate = `${truncateLabel(base, MAX_TAB_LABEL_LENGTH - suffix.length).trimEnd()}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

function truncateLabel(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join("");
}

function nestedSplitForPane(sourcePane: string): NestedSplitPlan | null {
  try {
    const response = parseResponse<{
      layout?: {
        zoomed?: boolean;
        panes?: Array<{ pane_id?: string; rect?: PaneSize }>;
      };
    }>(runHerdrSync(["pane", "layout", "--pane", sourcePane]), "pane layout");
    const layout = response.result?.layout;
    if (!layout || layout.zoomed) return null;
    const pane = layout.panes?.find((candidate) => candidate.pane_id === sourcePane);
    return pane?.rect ? planNestedSubagentSplit(pane.rect) : null;
  } catch {
    // Unknown geometry is not a safe reason to add another split.
    return null;
  }
}

/** Start a supported agent in a shell pane; args are passed directly to its CLI. */
export async function startAgent(
  name: string,
  kind: "pi" | "claude",
  paneId: string,
  args: string[],
): Promise<void> {
  requireHerdr();
  const commandArgs = ["agent", "start", name, "--kind", kind, "--pane", paneId, "--", ...args];
  const stdout = await runHerdr(commandArgs, 35_000);
  parseResponse(stdout, "agent start");
}

/** Submit a single prompt atomically to a recognized Herdr agent. */
export function promptAgent(target: string, prompt: string): void {
  requireHerdr();
  runHerdrSync(["agent", "prompt", target, prompt]);
}

/** Run a normal shell command in a pane (used by surface-level tests). */
export function sendCommand(surface: string, command: string): void {
  requireHerdr();
  runHerdrSync(["pane", "run", surface, command]);
}

/** Read recent terminal output from a pane as plain text. */
export function readScreen(surface: string, lines = 50): string {
  requireHerdr();
  return runHerdrSync([
    "pane",
    "read",
    surface,
    "--source",
    "recent-unwrapped",
    "--lines",
    String(Math.max(1, lines)),
  ]);
}

/** Async variant for watcher loops. */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireHerdr();
  return runHerdr([
    "pane",
    "read",
    surface,
    "--source",
    "recent-unwrapped",
    "--lines",
    String(Math.max(1, lines)),
  ]);
}

/** Close a Herdr pane. */
export function closeSurface(surface: string): void {
  requireHerdr();
  runHerdrSync(["pane", "close", surface]);
}

/** Whether Herdr still recognizes an agent in the subagent's pane. */
export async function isAgentRunning(surface: string): Promise<boolean> {
  requireHerdr();
  const stdout = await runHerdr(["agent", "list"]);
  const response = parseResponse<{ agents?: Array<{ pane_id?: string }> }>(stdout, "agent list");
  return response.result?.agents?.some((agent) => agent.pane_id === surface) ?? false;
}

// ── Exit polling ──

export interface PollResult {
  reason: "done" | "sentinel" | "agent-exit" | "error";
  /** Exit status when available. Agent disappearance does not expose an OS exit code. */
  exitCode: number;
  errorMessage?: string;
}

function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

function readExitSidecar(sessionFile: string | undefined): PollResult | null {
  if (!sessionFile) return null;

  const exitFile = `${sessionFile}.exit`;
  try {
    if (!existsSync(exitFile)) return null;
    const data = JSON.parse(readFileSync(exitFile, "utf-8"));
    rmSync(exitFile, { force: true });
    return interpretExitSidecar(data);
  } catch {
    return null;
  }
}

export const __pollForExitTest__ = { interpretExitSidecar, readExitSidecar };

/**
 * Wait for either the extension's error/completion sidecar, a Claude stop
 * sentinel, or Herdr to stop listing an agent in the child pane.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) throw new Error("Aborted while waiting for subagent to finish");

    const exitResult = readExitSidecar(options.sessionFile);
    if (exitResult) return exitResult;

    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) return { reason: "sentinel", exitCode: 0 };
      } catch {}
    }

    let agentRunning = true;
    try {
      agentRunning = await isAgentRunning(surface);
    } catch {
      // A transient Herdr/server error must not be confused with agent exit.
    }

    if (!agentRunning) {
      // The process can disappear just before the final sidecar becomes visible.
      return readExitSidecar(options.sessionFile) ?? { reason: "agent-exit", exitCode: 0 };
    }

    options.onTick?.(Math.floor((Date.now() - start) / 1000));
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
