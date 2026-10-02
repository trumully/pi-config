/**
 * Integration test harness for pi-interactive-subagents.
 *
 * Provides utilities to detect Herdr, create isolated agent definitions,
 * create panes, launch real Pi sessions, read terminal output, and clean up.
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readdirSync,
  rmSync,
  existsSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  isHerdrAvailable,
  createSurfaceSplit,
  createSubagentSurface,
  closeSubagentTab,
  startAgent,
  promptAgent,
  sendCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
} from "../../pi-extension/subagents/herdr.ts";

export {
  createSurfaceSplit,
  createSubagentSurface,
  closeSubagentTab,
  startAgent,
  promptAgent,
  sendCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
};

const HERDR_BIN = process.env.HERDR_BIN_PATH?.trim() || "herdr";

function herdrJson(args: string[]): any {
  const stdout = execFileSync(HERDR_BIN, args, {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  return JSON.parse(stdout.trim());
}

// ── Paths ──

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HARNESS_DIR, "../..");
const TEST_AGENTS_SRC = join(HARNESS_DIR, "agents");
const EXTENSION_SOURCE = join(PROJECT_ROOT, "pi-extension", "subagents", "index.ts");

// ── Configuration ──

/** Model used for integration tests. Override with PI_TEST_MODEL env var. */
export const TEST_MODEL = process.env.PI_TEST_MODEL ?? "anthropic/claude-haiku-4-5";

/** Per-test timeout in ms. Override with PI_TEST_TIMEOUT env var. */
export const PI_TIMEOUT = Number(process.env.PI_TEST_TIMEOUT ?? "120000");

// ── Backend detection ──

/** Detect whether the Herdr CLI is available in this process's pane. */
export function getAvailableBackends(): string[] {
  return isHerdrAvailable() ? ["herdr"] : [];
}

export function getFocusedSurface(): string | null {
  try {
    const response = herdrJson(["pane", "list"]);
    return response.result?.panes?.find((pane: any) => pane.focused)?.pane_id ?? null;
  } catch {
    return null;
  }
}

export function getSurfaceTab(surface: string): string | null {
  try {
    const workspaceId = process.env.HERDR_WORKSPACE_ID;
    if (!workspaceId) return null;
    const response = herdrJson(["pane", "list", "--workspace", workspaceId]);
    return response.result?.panes?.find((pane: any) => pane.pane_id === surface)?.tab_id ?? null;
  } catch {
    return null;
  }
}

export function getTabLabel(tabId: string): string | null {
  try {
    const workspaceId = process.env.HERDR_WORKSPACE_ID;
    if (!workspaceId) return null;
    const response = herdrJson(["tab", "list", "--workspace", workspaceId]);
    return response.result?.tabs?.find((tab: any) => tab.tab_id === tabId)?.label ?? null;
  } catch {
    return null;
  }
}

// ── Test environment ──

export interface TestEnv {
  dir: string;
  surfaces: string[];
  tabs: string[];
  surfaceTabs: Map<string, string>;
  tempFiles: string[];
}

export function createTestEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "pi-integ-"));
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  if (existsSync(TEST_AGENTS_SRC)) {
    for (const file of readdirSync(TEST_AGENTS_SRC)) {
      if (file.endsWith(".md")) cpSync(join(TEST_AGENTS_SRC, file), join(agentsDir, file));
    }
  }
  return { dir, surfaces: [], tabs: [], surfaceTabs: new Map(), tempFiles: [] };
}

export function cleanupTestEnv(env: TestEnv): void {
  for (const tab of env.tabs) {
    try { closeSubagentTab(tab); } catch {}
  }
  for (const surface of env.surfaces) {
    if (env.surfaceTabs.has(surface)) continue; // Closing its tracked tab closes the pane too.
    try { closeSurface(surface); } catch {}
  }
  for (const file of env.tempFiles) {
    try { unlinkSync(file); } catch {}
  }
  try { rmSync(env.dir, { recursive: true, force: true }); } catch {}
}

export function createTrackedSurface(env: TestEnv, name: string): string {
  const { surface, tabId } = createSubagentSurface(name, { cwd: env.dir });
  env.surfaces.push(surface);
  if (tabId) {
    env.tabs.push(tabId);
    env.surfaceTabs.set(surface, tabId);
  }
  return surface;
}

export function createTrackedSurfaceSplit(
  env: TestEnv,
  direction: "right" | "down",
  fromSurface?: string,
): string {
  const surface = createSurfaceSplit(direction, fromSurface, { cwd: env.dir });
  env.surfaces.push(surface);
  const parentTab = fromSurface ? env.surfaceTabs.get(fromSurface) : undefined;
  if (parentTab) env.surfaceTabs.set(surface, parentTab);
  return surface;
}

export function untrackSurface(env: TestEnv, surface: string): void {
  env.surfaces = env.surfaces.filter((candidate) => candidate !== surface);
  const tabId = env.surfaceTabs.get(surface);
  env.surfaceTabs.delete(surface);
  if (tabId && !Array.from(env.surfaceTabs.values()).includes(tabId)) {
    env.tabs = env.tabs.filter((candidate) => candidate !== tabId);
  }
}

// ── Pi session management ──

/** Start a Pi agent in a pane and submit its first prompt through Herdr. */
export async function startPi(
  surface: string,
  _testDir: string,
  task: string,
  opts?: { model?: string; extraArgs?: string[] },
): Promise<string> {
  const model = opts?.model ?? TEST_MODEL;
  const agentName = `pi-test-${uniqueId().replace(/[^a-z0-9]/gi, "").slice(-12).toLowerCase()}`;
  const args = ["-ne", "-e", EXTENSION_SOURCE, "--model", model, ...(opts?.extraArgs ?? [])];
  await startAgent(agentName, "pi", surface, args);
  promptAgent(agentName, task);
  return agentName;
}

// ── Cross-platform commands for pane surface tests ──

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function shellLiteral(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function echoCommand(value: string): string {
  if (process.platform === "win32") {
    const script = `Write-Output ${powershellLiteral(value)}`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return `powershell.exe -NoLogo -NoProfile -EncodedCommand ${encoded}`;
  }
  return `printf '%s\\n' ${shellLiteral(value)}`;
}

export function writeFileCommand(filePath: string, value: string, marker: string): string {
  if (process.platform === "win32") {
    const script = `Set-Content -LiteralPath ${powershellLiteral(filePath)} -Value ${powershellLiteral(value)}; Write-Output ${powershellLiteral(marker)}`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return `powershell.exe -NoLogo -NoProfile -EncodedCommand ${encoded}`;
  }
  return `printf '%s\\n' ${shellLiteral(value)} > ${shellLiteral(filePath)} && printf '%s\\n' ${shellLiteral(marker)}`;
}

// ── Polling helpers ──

export async function waitForScreen(
  surface: string,
  pattern: RegExp,
  timeout = PI_TIMEOUT,
  lines = 200,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const screen = await readScreenAsync(surface, lines);
      if (pattern.test(screen)) return screen;
    } catch {}
    await sleep(1000);
  }
  let finalScreen = "";
  try { finalScreen = readScreen(surface, lines); } catch {}
  throw new Error(
    `Timeout (${timeout}ms) waiting for pattern ${pattern}.\nLast screen:\n${finalScreen.slice(-1000)}`,
  );
}

export async function waitForFile(
  path: string,
  timeout = PI_TIMEOUT,
  contentPattern?: RegExp,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8");
      if (!contentPattern || contentPattern.test(content)) return content;
    }
    await sleep(1000);
  }
  throw new Error(`Timeout (${timeout}ms) waiting for file: ${path}` + (contentPattern ? ` matching ${contentPattern}` : ""));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function uniqueId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function trackTempFile(env: TestEnv, path: string): void {
  env.tempFiles.push(path);
}
