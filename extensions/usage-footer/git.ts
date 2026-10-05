import { execFileSync } from "node:child_process";

export function getGitBranch(cwd: string): string | null {
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
}
