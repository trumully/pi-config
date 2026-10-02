import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const require = createRequire(import.meta.url);
const MAX_MATCHES = 50;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_JSON_LINE_BYTES = 1024 * 1024;
const MAX_MATCH_TEXT = 500;
const TIMEOUT_MS = 30_000;

function getBinaryPath(): string {
  const platformPackages: Record<string, string> = {
    "win32-x64": "@ast-grep/cli-win32-x64-msvc",
    "win32-arm64": "@ast-grep/cli-win32-arm64-msvc",
    "win32-ia32": "@ast-grep/cli-win32-ia32-msvc",
    "darwin-x64": "@ast-grep/cli-darwin-x64",
    "darwin-arm64": "@ast-grep/cli-darwin-arm64",
    "linux-x64": "@ast-grep/cli-linux-x64-gnu",
    "linux-arm64": "@ast-grep/cli-linux-arm64-gnu",
  };
  const packageName = platformPackages[`${process.platform}-${process.arch}`];
  if (!packageName) {
    throw new Error(`ast-grep does not provide a binary for ${process.platform}-${process.arch}`);
  }
  try {
    const packageJson = require.resolve(`${packageName}/package.json`);
    return join(dirname(packageJson), process.platform === "win32" ? "ast-grep.exe" : "ast-grep");
  } catch {
    throw new Error(
      `ast-grep binary is missing for ${process.platform}-${process.arch}; reinstall extensions/ast-grep dependencies`,
    );
  }
}

type MatchRecord = {
  file?: string;
  text?: string;
  range?: { start?: { line?: number; column?: number } };
};

function search(
  binary: string,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  limit: number,
): Promise<{ matches: MatchRecord[]; truncated: boolean; stderr: string }> {
  return new Promise((resolveSearch, rejectSearch) => {
    const child = spawn(binary, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const matches: MatchRecord[] = [];
    let stdoutBuffer = "";
    let stdoutBytes = 0;
    let stderr = "";
    let truncated = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill();
      rejectSearch(error);
    };
    const stopAtLimit = () => {
      truncated = true;
      child.kill();
    };
    const abort = () => fail(new Error("ast-grep search cancelled"));

    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => fail(new Error(`ast-grep search timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);

    child.on("error", (error) => {
      fail(new Error(`Could not start ast-grep: ${error.message}`));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled || truncated) return;
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        stopAtLimit();
        return;
      }
      stdoutBuffer += chunk;
      let newline: number;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_JSON_LINE_BYTES) {
          stopAtLimit();
          return;
        }
        if (!line.trim()) continue;
        try {
          matches.push(JSON.parse(line) as MatchRecord);
        } catch {
          fail(new Error("ast-grep returned invalid JSON output"));
          return;
        }
        if (matches.length > limit) {
          stopAtLimit();
          return;
        }
      }
      if (Buffer.byteLength(stdoutBuffer) > MAX_JSON_LINE_BYTES) stopAtLimit();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8").slice(0, 4096 - stderr.length);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!truncated && stdoutBuffer.trim()) {
        try {
          matches.push(JSON.parse(stdoutBuffer) as MatchRecord);
        } catch {
          rejectSearch(new Error("ast-grep returned invalid JSON output"));
          return;
        }
      }
      if (!truncated && code !== 0 && !(code === 1 && matches.length === 0 && !stdoutBuffer.trim())) {
        rejectSearch(new Error(stderr.trim() || `ast-grep exited with code ${code ?? "unknown"}`));
        return;
      }
      resolveSearch({ matches, truncated, stderr });
    });
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ast_grep",
    label: "AST grep",
    description: "Search source code for a structural AST pattern. Read-only; returns matching file locations and short snippets.",
    parameters: Type.Object({
      pattern: Type.String({ minLength: 1, description: "Structural code pattern, such as `console.log($A)`" }),
      language: Type.String({ minLength: 1, description: "ast-grep language identifier, such as `typescript`, `python`, or `rust`" }),
      path: Type.Optional(Type.String({ description: "File or directory to search; defaults to the current working directory" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_MATCHES, description: "Maximum number of matches to return (default 20, maximum 50)" })),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const binary = getBinaryPath();
      const searchPath = params.path
        ? (isAbsolute(params.path) ? params.path : resolve(ctx.cwd, params.path))
        : ctx.cwd;
      const args = [
        "run",
        "--pattern", params.pattern,
        "--lang", params.language,
        "--json=stream",
        "--color=never",
        searchPath,
      ];
      const cap = params.limit ?? 20;
      const result = await search(binary, args, ctx.cwd, signal, cap);
      if (result.stderr.includes("Pattern contains an ERROR node")) {
        throw new Error("Invalid ast-grep pattern: the parser found an ERROR node");
      }
      const visible = result.matches.slice(0, cap);
      const lines = visible.map((match) => {
        const file = match.file ? relative(ctx.cwd, resolve(ctx.cwd, match.file)) || "." : searchPath;
        const start = match.range?.start;
        const location = start ? `${start.line === undefined ? "?" : start.line + 1}:${start.column === undefined ? "?" : start.column + 1}` : "?:?";
        const text = (match.text ?? "").replace(/\s+/g, " ").trim();
        const snippet = text.length > MAX_MATCH_TEXT ? `${text.slice(0, MAX_MATCH_TEXT)}…` : text;
        return `${file}:${location}: ${snippet}`;
      });
      const omittedByLimit = result.matches.length > cap;
      if (lines.length === 0) lines.push("No matches.");
      if (result.truncated || omittedByLimit) lines.push(`Results truncated at ${cap} matches or output limit.`);
      return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
    },
  });
}
