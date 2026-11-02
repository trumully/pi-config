/** herdr-app's terminal backend. The app discovers children through hc's parent link. */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { canonicalSessionPath } from "./lifecycle.ts";

const execFileAsync = promisify(execFile);
const executionOptions = { encoding: "utf8" as const, timeout: 35_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true };
const runner = fileURLToPath(new URL("./herdr-core-launcher.mjs", import.meta.url));

function piCliEntryPoint(): string {
  const runningEntryPoint = process.argv[1];
  if (runningEntryPoint) {
    let directory = dirname(runningEntryPoint);
    while (true) {
      try {
        const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
        if (manifest.name === "@earendil-works/pi-coding-agent") return runningEntryPoint;
      } catch {}
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  // Standalone Node tests may not be running from Pi's CLI; use ESM resolution there.
  return join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
}

export interface CoreSurfaceOptions {
  cwd?: string;
  env?: Record<string, string>;
  runName?: string;
}

interface CoreTerminal {
  address: string;
  name?: string | null;
  state: "live" | "finished";
  labels?: Record<string, string>;
}

export interface CoreCommands {
  sync(args: string[]): string;
  async(args: string[]): Promise<string>;
}

const commands: CoreCommands = {
  sync: (args) => execFileSync(process.env.HC_BIN_PATH?.trim() || "hc", args, executionOptions),
  async: async (args) => (await execFileAsync(process.env.HC_BIN_PATH?.trim() || "hc", args, executionOptions)).stdout,
};

function coreError(error: any): Error & { kind?: string } {
  let detail = String(error?.stderr || error?.stdout || error?.message || error).trim();
  let kind: string | undefined = error?.kind;
  try {
    const parsed = JSON.parse(detail).error;
    if (parsed) { detail = parsed.message || detail; kind = parsed.kind; }
  } catch {}
  return Object.assign(new Error(`hc: ${detail}`), { kind });
}

function json<T>(text: string): T {
  const result = JSON.parse(text.trim());
  if (result?.error) throw coreError({ stderr: text });
  return result as T;
}

export function isHerdrCoreEnvironment(): boolean {
  return !!process.env.HC_TERMINAL_ID;
}

export class HerdrCoreBackend {
  private pending = new Map<string, CoreSurfaceOptions>();
  private launchDirs = new Map<string, string>();

  private cli: CoreCommands;

  constructor(cli: CoreCommands = commands) { this.cli = cli; }

  isAvailable(): boolean {
    if (!isHerdrCoreEnvironment()) return false;
    try { this.cli.sync(["--version"]); return true; } catch { return false; }
  }

  /** Reserve a stable terminal name before claiming the transcript or submitting a launch. */
  createSurface(name: string, options: CoreSurfaceOptions = {}): { surface: string } {
    const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 18) || "agent";
    const surface = options.runName ?? `${slug}-${randomUUID().slice(0, 8)}`;
    if (!/^[a-z0-9_-]{1,32}$/.test(surface)) throw new Error("Invalid hc subagent terminal name");
    if (this.pending.has(surface)) throw new Error(`Terminal ${surface} is already reserved`);
    this.pending.set(surface, options);
    return { surface };
  }

  async startAgent(name: string, kind: "pi" | "claude", surface: string, args: string[], prompts: string[] = []): Promise<void> {
    // Reuse Pi's running JS entry point to avoid package-root resolution through the extension loader.
    const command = kind === "pi" ? [process.execPath, piCliEntryPoint()] : ["claude"];
    await this.startProgram(surface, [...command, ...args, ...(prompts.length ? ["--", ...prompts.filter(Boolean)] : [])], name,
      kind === "pi" ? command[1] : undefined, kind === "claude" ? prompts.filter(Boolean) : undefined);
  }

  /** Launch with a private descriptor so prompts and environment values never need shell quoting. */
  async startProgram(surface: string, argv: string[], identity = surface, moduleEntryPoint?: string, claudePrompts?: string[]): Promise<void> {
    const options = this.pending.get(surface);
    if (!options) throw new Error(`No reserved hc terminal ${surface}`);
    const directory = mkdtempSync(join(tmpdir(), "pi-hc-"));
    this.launchDirs.set(surface, directory);
    const descriptor = join(directory, "launch.json");
    // Claude is a native executable. Keep unusually large tasks below Windows' command-line limit.
    if (claudePrompts?.length && claudePrompts.join("\n\n").length > 8_000) {
      const taskFile = join(directory, "task.md");
      writeFileSync(taskFile, claudePrompts.join("\n\n"), { mode: 0o600 });
      argv = [...argv.slice(0, -(claudePrompts.length + 1)), "--", `Read ${JSON.stringify(taskFile)} and carry out the assignment in that file.`];
    }
    writeFileSync(descriptor, JSON.stringify({ argv, env: options.env ?? {}, moduleEntryPoint }), { mode: 0o600 });
    const args = ["run", "--bg", "--json", "--no-notify", "--outlive-parent", "--name", surface];
    if (process.env.HC_TERMINAL_ID) args.push("--parent", process.env.HC_TERMINAL_ID);
    args.push("--label", `pi.subagent=${identity}`);
    const session = options.env?.PI_SUBAGENT_SESSION;
    if (session) args.push("--label", `pi.session=${session}`);
    if (options.cwd) args.push("--cwd", options.cwd);
    args.push("--", process.execPath, runner, descriptor);
    // Once submitted, an uncertain failure must be reconciled through hc, not treated as an unused reservation.
    this.pending.delete(surface);
    try {
      const terminal = json<CoreTerminal>(await this.cli.async(args));
      if (typeof terminal.address !== "string" || terminal.name !== surface) {
        throw new Error("hc run returned no matching terminal identity");
      }
    } catch (error) { throw coreError(error); }
  }

  prompt(target: string, prompt: string): void {
    try { json(this.cli.sync(["send", "--json", target, prompt])); }
    catch (error) { throw coreError(error); }
  }

  read(surface: string, lines: number): string {
    try { return this.cli.sync(["read", surface, "--lines", String(Math.max(1, lines))]); }
    catch (error) { throw coreError(error); }
  }

  async readAsync(surface: string, lines: number): Promise<string> {
    try { return await this.cli.async(["read", surface, "--lines", String(Math.max(1, lines))]); }
    catch (error) { throw coreError(error); }
  }

  private parseTerminal(stdout: string): CoreTerminal {
    const terminal = json<CoreTerminal>(stdout);
    if (typeof terminal.address !== "string" || !["live", "finished"].includes(terminal.state)) {
      throw new Error("hc get returned an invalid terminal");
    }
    return terminal;
  }

  private getSync(target: string): CoreTerminal | null {
    try { return this.parseTerminal(this.cli.sync(["get", target, "--json"])); }
    catch (error) {
      const parsed = coreError(error);
      if (parsed.kind === "not_found") return null;
      throw parsed;
    }
  }

  private async get(target: string): Promise<CoreTerminal | null> {
    try { return this.parseTerminal(await this.cli.async(["get", target, "--json"])); }
    catch (error) {
      const parsed = coreError(error);
      if (parsed.kind === "not_found") return null;
      throw parsed;
    }
  }

  async runningSurfaces(): Promise<Set<string>> {
    const response = json<{ terminals: CoreTerminal[] }>(await this.cli.async(["ls", "--json"]));
    if (!Array.isArray(response.terminals)) throw new Error("hc ls returned no terminals array");
    return new Set(response.terminals.filter((t) => t.state === "live").map((t) => t.name || t.address));
  }

  async getRunningSurface(target: string, fallback?: { surface: string; sessionFile: string }): Promise<{ surface: string } | null> {
    const terminal = await this.get(target);
    if (terminal?.state === "live") {
      if (terminal.labels?.["pi.subagent"] !== target) throw new Error(`Cannot confirm hc run identity ${target}`);
      if (fallback && terminal.labels?.["pi.session"] &&
          canonicalSessionPath(terminal.labels["pi.session"]) !== canonicalSessionPath(fallback.sessionFile)) {
        throw new Error(`hc transcript identity mismatch for ${target}`);
      }
      return { surface: terminal.name || terminal.address };
    }
    if (fallback) {
      if (!/^[a-z0-9_-]{1,32}$/.test(fallback.surface)) {
        throw new Error("Cannot reconcile a legacy Herdr pane through hc");
      }
      const response = json<{ terminals: CoreTerminal[] }>(await this.cli.async([
        "ls", "--json", "--label", `pi.session=${fallback.sessionFile}`,
      ]));
      if (!Array.isArray(response.terminals)) throw new Error("hc ls returned no terminals array");
      for (const item of response.terminals) {
        const live = await this.get(item.address);
        if (live?.state !== "live") continue;
        const session = live.labels?.["pi.session"];
        if (session && canonicalSessionPath(session) === canonicalSessionPath(fallback.sessionFile)) {
          return { surface: live.name || live.address };
        }
      }
      if ((await this.get(fallback.surface))?.state === "live") {
        throw new Error("Saved hc terminal still has an unconfirmed run identity");
      }
    }
    return null;
  }

  close(surface: string): void {
    if (this.pending.delete(surface)) return;
    const terminal = this.getSync(surface);
    if (terminal) {
      if (!terminal.labels?.["pi.subagent"]) throw new Error(`Refusing to close unowned hc terminal ${surface}`);
      // Use the immutable address after lookup, never a name that could be reused after exit.
      if (terminal.state === "live") json(this.cli.sync(["kill", terminal.address, "--json"]));
      json(this.cli.sync(["rm", terminal.address, "--json"]));
    }
    const directory = this.launchDirs.get(surface);
    if (directory) rmSync(directory, { recursive: true, force: true });
    this.launchDirs.delete(surface);
  }
}

export const herdrCore = new HerdrCoreBackend();
