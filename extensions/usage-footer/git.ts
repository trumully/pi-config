import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

export interface GitFooterInfo {
  branch: string | null;
  rebasing: boolean | null;
}

const CACHE_MS = 5_000;
const cache = new Map<string, { checkedAt: number; info: GitFooterInfo }>();

const GIT_TIMEOUT_MS = 300;

type GitCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function runGit(cwd: string, args: string[]): GitCommandResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
    });
    return { status: 0, stdout: stdout.trim(), stderr: "" };
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string };
    return {
      status: typeof failure.status === "number" ? failure.status : null,
      stdout: typeof failure.stdout === "string" ? failure.stdout.trim() : "",
      stderr: typeof failure.stderr === "string" ? failure.stderr.trim() : "",
    };
  }
}

function gitState(cwd: string): { info: GitFooterInfo; cacheable: boolean } {
  const topLevel = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (topLevel.status !== 0) {
    const isOutsideRepository = /not a git repository/i.test(topLevel.stderr);
    return {
      info: { branch: null, rebasing: isOutsideRepository ? false : null },
      cacheable: isOutsideRepository,
    };
  }

  const symbolicRef = runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  let branch: string;
  if (symbolicRef.status === 0 && symbolicRef.stdout) {
    // symbolic-ref succeeds for attached and unborn branches.
    branch = symbolicRef.stdout;
  } else if (symbolicRef.status === 1) {
    // Only symbolic-ref's documented status 1 means HEAD is not a symbolic ref.
    const commit = runGit(cwd, ["rev-parse", "--short", "HEAD"]);
    if (commit.status !== 0 || !commit.stdout) {
      return { info: { branch: null, rebasing: null }, cacheable: false };
    }
    branch = `detached ${commit.stdout}`;
  } else {
    return { info: { branch: null, rebasing: null }, cacheable: false };
  }

  const rebaseMerge = runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge"]);
  const rebaseApply = runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "rebase-apply"]);
  if (rebaseMerge.status !== 0 || !rebaseMerge.stdout || rebaseApply.status !== 0 || !rebaseApply.stdout) {
    return { info: { branch, rebasing: null }, cacheable: false };
  }

  const mergeDir = rebaseMerge.stdout;
  const applyDir = rebaseApply.stdout;
  const mergeHeadNameExists = existsSync(`${mergeDir}/head-name`);
  const applyRebasingExists = existsSync(`${applyDir}/rebasing`);
  const applyingExists = existsSync(`${applyDir}/applying`);
  const mergeDirExists = existsSync(mergeDir);
  const applyDirExists = existsSync(applyDir);
  const rebasing = mergeHeadNameExists || applyRebasingExists
    ? true
    : (mergeDirExists && !mergeHeadNameExists) || (applyDirExists && !applyingExists)
      ? null
      : false;
  return { info: { branch, rebasing }, cacheable: rebasing !== null };
}

export function invalidateGitFooterInfo(cwd: string): void {
  cache.delete(cwd);
}

export function getGitFooterInfo(cwd: string, now = Date.now()): GitFooterInfo {
  const cached = cache.get(cwd);
  if (cached && now - cached.checkedAt < CACHE_MS) return cached.info;

  const state = gitState(cwd);
  if (state.cacheable) cache.set(cwd, { checkedAt: now, info: state.info });
  return state.info;
}

export function getGitBranch(cwd: string): string | null {
  return getGitFooterInfo(cwd).branch;
}
