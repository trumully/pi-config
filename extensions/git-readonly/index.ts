/** Shell-free local Git inspection. Callers choose operations, never Git flags. */
import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { compactRenderers, quoteArg } from "../readonly-tool-ui/render.ts";

const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;
const MAX_RESULT_LINES = 500;
const TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 1_000;
const NARROW_HINT = "Narrow paths or use format: stat/names; paginate log with limit/offset.";
const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";

const Repo = Type.Optional(Type.String({ minLength: 1, maxLength: 2048, description: "Local repository directory, relative to the session working directory or absolute. Defaults to the session working directory. Requires Git 2.45+." }));
const Paths = Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 20, description: "Literal paths relative to repo. No absolute paths, backslashes, or .. segments. No pathspec magic." }));
const Ref = Type.String({ minLength: 1, maxLength: 256, description: "Commit-ish such as HEAD, a branch, tag, SHA, or HEAD~2. Resolved to a commit ID before inspection." });
const Format = Type.Optional(Type.Union([Type.Literal("patch"), Type.Literal("stat"), Type.Literal("names")]));
const Params = Type.Object({
  operation: Type.Union([Type.Literal("status"), Type.Literal("diff"), Type.Literal("show"), Type.Literal("log")]),
  repo: Repo, paths: Paths,
  base: Type.Optional(Ref), target: Type.Optional(Ref), staged: Type.Optional(Type.Boolean()), format: Format,
  ref: Type.Optional(Ref),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
}, { additionalProperties: false });
type Params = Static<typeof Params>;
type Status = "success" | "cancelled" | "timeout" | "output_limit" | "missing_executable" | "command_failed" | "spawn_failed";
interface Result { text: string; status: Status; exitCode: number | null }

function validateInput(params: Params): void {
  const fields: Record<Params["operation"], string[]> = {
    status: [], diff: ["base", "target", "staged", "format"], show: ["ref", "format"], log: ["ref", "limit", "offset"],
  };
  const allowed = new Set(["operation", "repo", "paths", ...fields[params.operation]]);
  for (const key of Object.keys(params)) if (!allowed.has(key)) throw new Error(`git_readonly: ${key} is not supported for ${params.operation}`);
  if (params.repo && /[\0\r\n]/.test(params.repo)) throw new Error("git_readonly: invalid repository path");
  for (const path of params.paths ?? []) {
    if (/[\0\r\n\\:]/.test(path) || path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error("git_readonly: paths must be literal relative paths without backslashes, colons, or .. segments");
    }
  }
  const refs = params.operation === "diff" ? [params.base, params.target] : "ref" in params ? [params.ref] : [];
  for (const ref of refs) {
    if (ref && (ref.startsWith("-") || /[\0\r\n]/.test(ref))) throw new Error("git_readonly: invalid commit reference");
  }
  if (params.operation === "diff") {
    if (params.target && !params.base) throw new Error("git_readonly: target requires base");
    if (params.staged && (params.base || params.target)) throw new Error("git_readonly: staged cannot be combined with base or target");
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Remove environment-injected commands and repository/config redirection.
  // Retain standard system/global config for EOL handling and ownership policy;
  // executable helpers are disabled by the command prefix and filter discovery.
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  return Object.assign(env, {
    GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1", GIT_PAGER: "cat", LC_ALL: "C",
  });
}

const BASE_ARGS = [
  "--no-pager", "--no-optional-locks", "--literal-pathspecs",
  "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${nullDevice}`,
  "-c", "core.untrackedCache=false",
  "-c", "diff.autoRefreshIndex=false", "-c", "color.ui=false",
  "-c", "protocol.allow=never", "-c", "protocol.file.allow=never",
  "-c", "maintenance.auto=false", "-c", "gc.auto=0",
];

/** Search only explicit absolute PATH directories, never the inspected checkout. */
function resolveGitExecutable(repo: string, env: NodeJS.ProcessEnv): string | undefined {
  const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
  const excluded = [canonical(repo), canonical(process.cwd())];
  const inCheckout = (path: string) => excluded.some((root) => {
    const suffix = relative(root, path);
    return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
  });
  const pathKey = Object.keys(env).find((key) => /^PATH$/i.test(key));
  for (const entry of (pathKey ? env[pathKey] ?? "" : "").split(delimiter)) {
    const dir = entry.replace(/^"(.*)"$/, "$1");
    if (!isAbsolute(dir)) continue;
    try {
      const executable = realpathSync(join(dir, process.platform === "win32" ? "git.exe" : "git"));
      if (inCheckout(executable) || !statSync(executable).isFile()) continue;
      accessSync(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return executable;
    } catch { /* Try the next explicit PATH directory. */ }
  }
  return undefined;
}

/** Bounded raw capture. Internal config/ref results must never be silently clipped. */
function runGit(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, deadline: number, signal?: AbortSignal): Promise<Result> {
  if (signal?.aborted) return Promise.resolve({ text: "Git request cancelled.", status: "cancelled", exitCode: null });
  if (Date.now() >= deadline) return Promise.resolve({ text: "Git request timed out.", status: "timeout", exitCode: null });
  return new Promise((resolveResult) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let captured = 0;
    let settled = false;
    let failure: Result | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: Result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(settleTimer);
      signal?.removeEventListener("abort", onAbort);
      resolveResult(result);
    };
    const kill = (killSignal: NodeJS.Signals) => {
      try { child.kill(killSignal); } catch { /* The fallback still settles the call. */ }
    };
    const stop = (status: Status, text: string) => {
      if (settled || failure) return;
      failure = { status, text, exitCode: null };
      clearTimeout(timer);
      kill("SIGTERM");
      killTimer = setTimeout(() => {
        kill("SIGKILL");
        settleTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          finish({ ...failure!, text: `${text}\nProcess exit could not be confirmed; inspect the local Git process before retrying.` });
        }, TERMINATION_GRACE_MS);
      }, TERMINATION_GRACE_MS);
    };
    const onAbort = () => stop("cancelled", "Git request cancelled.");
    const timer = setTimeout(() => stop("timeout", "Git request exceeded its 30 second deadline. Narrow the request before retrying."), Math.max(1, deadline - Date.now()));
    const collect = (chunk: Buffer, target: Buffer[]) => {
      if (settled || failure) return;
      captured += chunk.length;
      if (captured > MAX_CAPTURE_BYTES) return stop("output_limit", `Git output exceeded the 256 KiB capture limit. ${NARROW_HINT}`);
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, stdout));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, stderr));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (failure) return;
      finish({ status: error.code === "ENOENT" ? "missing_executable" : "spawn_failed", exitCode: null,
        text: error.code === "ENOENT" ? "Could not start Git. Check that git is on PATH and the repository directory exists." : `Could not run Git: ${error.message}` });
    });
    child.on("close", (code, exitSignal) => {
      if (failure) return finish({ ...failure, exitCode: code });
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8").trim();
      finish({ status: code === 0 ? "success" : "command_failed", exitCode: code,
        text: code === 0 ? out : `Git failed (${code ?? exitSignal ?? "unknown"}).\n${err}\n${out}`.trim() });
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

const DIFF_ARGS = ["--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--no-renames", "--no-color"];
function formatArgs(format?: "patch" | "stat" | "names"): string[] {
  return format === "stat" ? ["--stat"] : format === "names" ? ["--name-status"] : ["--patch"];
}

async function inspect(params: Params, cwd: string, signal?: AbortSignal): Promise<Result & { commits: Record<string, string> }> {
  const env = gitEnvironment();
  const deadline = Date.now() + TIMEOUT_MS;
  const commits: Record<string, string> = {};
  const executable = resolveGitExecutable(cwd, env);
  if (!executable) return { text: "Git was not found in an absolute PATH directory outside the checkout. Install or configure Git outside the repository.", status: "missing_executable", exitCode: null, commits };
  let prefix = [...BASE_ARGS];
  const run = (args: string[]) => runGit(executable, [...prefix, ...args], cwd, env, deadline, signal);

  const version = await run(["--version"]);
  if (version.status !== "success") return { ...version, commits };
  const match = version.text.match(/^git version (\d+)\.(\d+)/);
  if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 45)) {
    throw new Error("git_readonly requires Git 2.45 or newer for local-only inspection controls");
  }

  // Working-tree diff can invoke clean/process filters even with --no-textconv.
  // Discover configured filter names without executing them, including includes,
  // then disable their commands at the highest config precedence before reading.
  const config = await run(["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"]);
  if (config.status !== "success" && !(config.status === "command_failed" && config.exitCode === 1)) return { ...config, commits };
  if (config.status === "success") {
    const drivers = new Set<string>();
    for (const key of config.text.split("\0").filter(Boolean)) {
      const match = key.match(/^(filter\..+)\.(?:clean|smudge|process|required)$/i);
      // `git -c` splits on the first '=' even when it belongs to a subsection.
      if (!match || /[=\0\r\n]/.test(key)) throw new Error("git_readonly: unsupported filter configuration; inspect outside this tool");
      drivers.add(match[1]);
    }
    for (const driver of drivers) prefix.push("-c", `${driver}.clean=`, "-c", `${driver}.smudge=`, "-c", `${driver}.process=`, "-c", `${driver}.required=false`);
    if (prefix.join(" ").length > 20_000) throw new Error("git_readonly: too much filter configuration for a bounded invocation");
  }

  const resolveCommit = async (ref: string, label: string): Promise<Result | undefined> => {
    const result = await run(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
    if (result.status !== "success") return result;
    const oid = result.text.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) throw new Error("git_readonly: Git returned an invalid commit ID");
    commits[label] = oid;
    return undefined;
  };
  const paths = ["--", ...(params.paths ?? [])];
  let args: string[];
  if (params.operation === "status") {
    args = ["status", "--short", "--branch", "--untracked-files=normal", "--ignore-submodules=all", ...paths];
  } else if (params.operation === "diff") {
    for (const label of ["base", "target"] as const) {
      const ref = params[label];
      if (ref) {
        const failure = await resolveCommit(ref, label);
        if (failure) return { ...failure, commits };
      }
    }
    args = ["diff", ...DIFF_ARGS, ...formatArgs(params.format), ...(params.staged ? ["--cached"] : []), ...Object.values(commits), ...paths];
  } else {
    const failure = await resolveCommit(params.ref ?? "HEAD", "ref");
    if (failure) return { ...failure, commits };
    args = params.operation === "show"
      ? ["show", "--format=fuller", "--no-show-signature", "--no-notes", ...DIFF_ARGS, ...formatArgs(params.format), commits.ref, ...paths]
      : ["log", "--no-patch", "--no-show-signature", "--no-notes", "--no-decorate", "--format=commit %H%nAuthor: %an <%ae>%nDate: %aI%n%n    %s", `--max-count=${params.limit ?? 20}`, `--skip=${params.offset ?? 0}`, commits.ref, ...paths];
  }
  return { ...await run(args), commits };
}

function boundOutput(text: string): { text: string; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  let output = lines.slice(0, MAX_RESULT_LINES).join("\n");
  let truncated = lines.length > MAX_RESULT_LINES;
  if (Buffer.byteLength(output, "utf8") > MAX_RESULT_BYTES) {
    output = Buffer.from(output, "utf8").subarray(0, MAX_RESULT_BYTES).toString("utf8");
    truncated = true;
  }
  return { text: output + (truncated ? `\n[Output truncated by git_readonly. ${NARROW_HINT}]` : ""), truncated };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "git_readonly",
    label: "Git (read-only)",
    description: "Inspect a local Git repository without a shell or arbitrary flags. Operations: status; diff (unstaged by default, staged: true for index vs HEAD, base for commit vs worktree, base+target for two commits); show (one commit); log (bounded history). Optional repo selects a local directory; paths are literal relative paths. References resolve to commit IDs. No writes, fetch/clone, hooks, external diff/textconv, or configured clean/process filters. Output capped at 32 KiB/500 lines; 30 second request deadline. Use gh_readonly for GitHub data.",
    parameters: Params,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      validateInput(params);
      const started = Date.now();
      const repo = resolve(ctx.cwd, params.repo ?? ".");
      const result = await inspect(params, repo, signal);
      const output = boundOutput(result.text);
      return {
        content: [{ type: "text", text: output.text || "(no output)" }],
        isError: result.status !== "success",
        details: { operation: params.operation, repo, commits: result.commits, status: result.status, exitCode: result.exitCode, truncated: output.truncated || result.status === "output_limit", durationMs: Date.now() - started },
      };
    },
    ...compactRenderers<Partial<Params>>({
      title: "git_readonly",
      summarize: (params) => describeCall(params, false),
      describe: (params) => describeCall(params, true),
    }),
  });
}

/** Display text for a call, such as `diff main..HEAD stat -- src/a.ts +2 more`. Arguments may still be streaming. */
function describeCall(params: Partial<Params> | undefined, full: boolean): string {
  if (!params || typeof params.operation !== "string") return "";
  const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? quoteArg(String(value)) : undefined);
  const parts: Array<string | undefined> = [params.operation];
  if (params.operation === "diff") {
    parts.push(params.staged === true ? "--staged" : params.base ? `${text(params.base)}${params.target ? `..${text(params.target)}` : ""}` : undefined);
  }
  if (params.operation === "show" || params.operation === "log") parts.push(text(params.ref));
  if (params.format) parts.push(text(params.format));
  if (params.limit !== undefined) parts.push("limit", text(params.limit));
  if (params.offset !== undefined) parts.push("offset", text(params.offset));
  if (params.repo) parts.push("in", text(params.repo));
  const paths = Array.isArray(params.paths) ? params.paths.map((path) => text(path) ?? "") : [];
  if (paths.length > 0) parts.push("--", ...(full || paths.length === 1 ? paths : [paths[0], `+${paths.length - 1} more`]));
  return parts.filter((part) => part !== undefined && part !== "").join(" ");
}
