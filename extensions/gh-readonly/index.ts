/**
 * A deliberately narrow, shell-free GitHub CLI tool for repository scouting.
 * No user-controlled executable, shell syntax, write command, or output path is accepted.
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;
const MAX_RESULT_LINES = 500;
const TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 1_000;
const NARROW_OUTPUT_HINT = "Narrow the request with --json/--jq, a smaller --limit, or explicit REST page/per_page parameters.";

const Args = Type.Object({
  args: Type.Array(Type.String({ maxLength: 2048 }), {
    minItems: 1,
    maxItems: 40,
    description: "Argument vector for an allowed read-only gh command, without the initial `gh` executable. Example: [\"repo\", \"view\", \"OWNER/REPO\", \"--json\", \"nameWithOwner,url\"].",
  }),
});

const commonRepoFlags: Record<string, "value"> = { "--repo": "value" };
const COMMANDS: Record<string, { flags: Record<string, "value" | "boolean">; positional: number[] }> = {
  "repo view": { flags: { "--json": "value", "--jq": "value" }, positional: [1] },
  "repo list": { flags: { "--limit": "value", "--visibility": "value", "--source": "boolean", "--json": "value", "--jq": "value" }, positional: [0, 1] },
  "pr view": { flags: { ...commonRepoFlags, "--json": "value", "--jq": "value", "--comments": "boolean" }, positional: [1] },
  "pr list": { flags: { ...commonRepoFlags, "--state": "value", "--limit": "value", "--base": "value", "--head": "value", "--author": "value", "--assignee": "value", "--label": "value", "--json": "value", "--jq": "value" }, positional: [0] },
  "pr diff": { flags: { ...commonRepoFlags, "--patch": "boolean", "--name-only": "boolean", "--color": "value" }, positional: [1] },
  "pr checks": { flags: { ...commonRepoFlags, "--required": "boolean", "--json": "value", "--jq": "value" }, positional: [1] },
  "issue view": { flags: { ...commonRepoFlags, "--json": "value", "--jq": "value", "--comments": "boolean" }, positional: [1] },
  "issue list": { flags: { ...commonRepoFlags, "--state": "value", "--limit": "value", "--assignee": "value", "--author": "value", "--label": "value", "--milestone": "value", "--json": "value", "--jq": "value" }, positional: [0] },
  "release list": { flags: { ...commonRepoFlags, "--limit": "value", "--json": "value", "--jq": "value" }, positional: [0] },
  "release view": { flags: { ...commonRepoFlags, "--json": "value", "--jq": "value" }, positional: [1] },
  "run list": { flags: { ...commonRepoFlags, "--branch": "value", "--commit": "value", "--event": "value", "--status": "value", "--workflow": "value", "--limit": "value", "--json": "value", "--jq": "value" }, positional: [0] },
  "run view": { flags: { ...commonRepoFlags, "--json": "value", "--jq": "value" }, positional: [1] },
  "search code": { flags: { "--repo": "value", "--owner": "value", "--language": "value", "--filename": "value", "--extension": "value", "--match": "value", "--limit": "value" }, positional: [1] },
  "search issues": { flags: { "--repo": "value", "--state": "value", "--label": "value", "--author": "value", "--assignee": "value", "--limit": "value", "--sort": "value", "--order": "value" }, positional: [1] },
  "search prs": { flags: { "--repo": "value", "--state": "value", "--label": "value", "--author": "value", "--assignee": "value", "--base": "value", "--head": "value", "--limit": "value", "--sort": "value", "--order": "value" }, positional: [1] },
  "search commits": { flags: { "--repo": "value", "--author": "value", "--committer": "value", "--limit": "value", "--sort": "value", "--order": "value" }, positional: [1] },
};

const reject = (reason: string): never => { throw new Error(`gh_readonly rejected arguments: ${reason}`); };

function safeValue(flag: string, value: string): boolean {
  if (!value || value.length > 2048 || /[\0\r\n]/.test(value) || value.startsWith("-")) return false;
  if (flag === "--repo") return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
  if (flag === "--limit") return /^\d{1,3}$/.test(value) && Number(value) >= 1 && Number(value) <= 100;
  if (flag === "--json") return /^[A-Za-z][A-Za-z0-9]*(,[A-Za-z][A-Za-z0-9]*)*$/.test(value);
  if (flag === "--jq") return value.length <= 512;
  if (["--state", "--visibility", "--status", "--event", "--order", "--color", "--match"].includes(flag)) return /^[A-Za-z0-9_-]+$/.test(value);
  return true;
}

/** Validate and return the exact argv that may be passed to `gh`. */
export function validateReadonlyGhArgs(input: unknown): string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 40 || !input.every((v) => typeof v === "string")) {
    return reject("args must be an array of 1 to 40 strings");
  }
  const args = input as string[];
  if (args.some((v) => v.length > 2048 || /[\0\r\n]/.test(v))) return reject("arguments contain invalid characters or are too long");

  if (args[0] === "api") {
    let method = false;
    let endpoint: string | undefined;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--method") {
        if (method || args[++i] !== "GET") return reject("REST API requests require exactly --method GET");
        method = true;
      } else if (args[i] === "--jq") {
        const jq = args[++i];
        if (!jq || jq.startsWith("-") || jq.length > 512) return reject("invalid --jq expression");
      } else if (args[i].startsWith("-")) {
        return reject(`unsupported API flag ${args[i]}`);
      } else if (endpoint === undefined) endpoint = args[i];
      else return reject("only one REST endpoint is allowed");
    }
    if (!method) return reject("REST API requests require explicit --method GET");
    if (!endpoint || endpoint.length > 1024 || endpoint.startsWith("/") || /[%#\\\s]/.test(endpoint) || endpoint.includes("..") || endpoint.includes("//")) {
      return reject("endpoint must be a safe relative REST path");
    }
    const path = endpoint.split("?", 1)[0];
    if (!/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path)) {
      return reject("only explicit repository REST endpoints are allowed (GraphQL is disabled)");
    }
    if (endpoint.includes("?") && !/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*(?:\?[A-Za-z0-9_.-]+=[A-Za-z0-9_.-]*(?:&[A-Za-z0-9_.-]+=[A-Za-z0-9_.-]*)*)?$/.test(endpoint)) {
      return reject("query string contains unsupported characters");
    }
    return args;
  }

  const key = args.slice(0, 2).join(" ");
  const spec = COMMANDS[key];
  if (!spec) return reject("command is not on the read-only allowlist");
  let positionalCount = 0;
  let explicitRepo = false;
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      const flag = spec.flags[arg];
      if (!flag) return reject(`unsupported flag ${arg} for ${key}`);
      if (flag === "boolean") continue;
      const value = args[++i];
      if (!value || !safeValue(arg, value)) return reject(`invalid value for ${arg}`);
      if (arg === "--repo") explicitRepo = true;
    } else {
      positionalCount++;
      if (!safeValue("", arg)) return reject("invalid positional argument");
      if (key === "repo view" && !safeValue("--repo", arg)) return reject("repo view requires an explicit OWNER/REPO positional argument");
      if (["pr view", "pr diff", "pr checks", "issue view", "release view", "run view"].includes(key) && !/^[A-Za-z0-9_.-]+$/.test(arg)) return reject(`invalid identifier for ${key}`);
    }
  }
  if (!spec.positional.includes(positionalCount)) return reject(`unexpected positional arguments for ${key}`);
  const repoScoped = ["pr view", "pr list", "pr diff", "pr checks", "issue view", "issue list", "release list", "release view", "run list", "run view"].includes(key);
  if (repoScoped && !explicitRepo) return reject(`${key} requires explicit --repo OWNER/REPO`);
  if (args.includes("--web")) return reject("browser-opening flags are disabled");
  if (args.includes("--watch")) return reject("long-running watch mode is disabled");
  return args;
}

function redact(text: string): string {
  return text
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_TOKEN]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(authorization\s*[:=]\s*)\S+/gi, "$1[REDACTED]");
}

function formatOutput(text: string): { text: string; truncated: boolean } {
  // Redact before clipping so a token spanning the output boundary is not exposed.
  const lines = redact(text).split(/\r?\n/);
  let result = lines.slice(0, MAX_RESULT_LINES).join("\n");
  let truncated = lines.length > MAX_RESULT_LINES;
  if (Buffer.byteLength(result, "utf8") > MAX_RESULT_BYTES) {
    result = Buffer.from(result, "utf8").subarray(0, MAX_RESULT_BYTES).toString("utf8");
    truncated = true;
  }
  return {
    text: result + (truncated ? `\n[Output truncated by gh_readonly. ${NARROW_OUTPUT_HINT}]` : ""),
    truncated,
  };
}

export function boundOutput(text: string): string {
  return formatOutput(text).text;
}

type GhStatus = "success" | "cancelled" | "timeout" | "output_limit" | "missing_executable" | "authentication" | "command_failed" | "spawn_failed";
interface GhResult {
  text: string;
  status: GhStatus;
  exitCode: number | null;
  truncated: boolean;
  durationMs: number;
}

function executeGh(args: string[], signal?: AbortSignal): Promise<GhResult> {
  const started = Date.now();
  if (signal?.aborted) {
    return Promise.resolve({ text: "GitHub request cancelled before starting gh.", status: "cancelled", exitCode: null, truncated: false, durationMs: 0 });
  }
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^GH_DEBUG$/i.test(key)) delete env[key];
    Object.assign(env, {
      GH_PROMPT_DISABLED: "1",
      GH_PAGER: "cat",
      PAGER: "cat",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    });
    const child = spawn("gh", args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let captured = 0;
    let settled = false;
    let failure: { status: GhStatus; text: string } | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (status: GhStatus, text: string, exitCode: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(settleTimer);
      signal?.removeEventListener("abort", onAbort);
      const output = formatOutput(text);
      resolve({ ...output, status, exitCode, truncated: output.truncated || status === "output_limit", durationMs: Date.now() - started });
    };
    const kill = (killSignal: NodeJS.Signals) => {
      try { child.kill(killSignal); } catch { /* The bounded fallback below still settles the call. */ }
    };
    const stop = (status: GhStatus, text: string) => {
      if (settled || failure) return;
      failure = { status, text };
      clearTimeout(timer);
      kill("SIGTERM");
      killTimer = setTimeout(() => {
        kill("SIGKILL");
        // A stuck child or inherited pipe must not hold the tool call open forever.
        settleTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          finish(status, `${text}\nProcess exit could not be confirmed after termination; inspect the local gh process before retrying.`);
        }, TERMINATION_GRACE_MS);
      }, TERMINATION_GRACE_MS);
    };
    const onAbort = () => stop("cancelled", "GitHub request cancelled.");
    const timer = setTimeout(() => stop("timeout", `gh timed out after ${TIMEOUT_MS / 1000} seconds. Narrow the request before retrying.`), TIMEOUT_MS);

    const collect = (chunk: Buffer, target: Buffer[]) => {
      if (settled || failure) return;
      captured += chunk.length;
      if (captured > MAX_CAPTURE_BYTES) {
        stop("output_limit", `gh output exceeded the 256 KiB capture limit. ${NARROW_OUTPUT_HINT}`);
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, stdout));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, stderr));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (failure) return; // Retain termination timers if killing a live process failed.
      if (error.code === "ENOENT") finish("missing_executable", "GitHub CLI (gh) was not found on PATH. Install it outside the agent, then retry.");
      else finish("spawn_failed", `Could not run gh: ${error.message}`);
    });
    child.on("close", (code, exitSignal) => {
      if (failure) return finish(failure.status, failure.text, code);
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        const auth = code === 4 || /HTTP 401|requires authentication|not logged into|gh auth login/i.test(err);
        const hint = auth ? " Check gh authentication outside the agent (gh auth status / gh auth login); do not share tokens." : "";
        return finish(auth ? "authentication" : "command_failed", `gh failed (${code ?? exitSignal ?? "unknown"}).${hint}\n${err}\n${out}`.trim(), code);
      }
      finish("success", out, code);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "gh_readonly",
    label: "GitHub (read-only)",
    description: "Run a strictly allowlisted, read-only `gh` command using an argument array (no shell). Supports repository/PR/issue/release/run inspection, search, and explicit repository REST GET endpoints. For repo view, pass OWNER/REPO as a positional argument; for PR/issue/release/run commands, supply --repo OWNER/REPO. Workflow runs expose metadata only; log download flags are blocked to avoid local file writes. Writes, auth/config, clone/download, local file I/O, browser, GraphQL, arbitrary flags, and watch mode are blocked. Output is capped at 32 KiB/500 lines; requests time out after 30 seconds.",
    parameters: Args,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async execute(_toolCallId, params, signal) {
      const args = validateReadonlyGhArgs(params.args);
      const { text, ...metadata } = await executeGh(args, signal);
      return {
        content: [{ type: "text", text: text || "(no output)" }],
        isError: metadata.status !== "success",
        details: { command: ["gh", ...args], ...metadata },
      };
    },
  });
}
