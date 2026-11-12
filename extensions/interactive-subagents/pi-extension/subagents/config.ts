import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const USER_CONFIG_FILE = "subagents.json";
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const LEGACY_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
export const EXAMPLE_CONFIG_PATH = join(PACKAGE_ROOT, "config.json.example");

/**
 * Internal: the exact config file a parent selected. Children inherit it so a
 * project-local PI_CODING_AGENT_DIR cannot swap in different settings.
 */
export const SUBAGENT_CONFIG_FILE_ENV = "PI_SUBAGENT_CONFIG_FILE";

/**
 * Config files in precedence order, resolved now so environment changes apply.
 * A non-empty inherited pin is the only candidate, so a missing or broken
 * pinned file fails instead of falling back. Otherwise: the user's
 * `<agent-dir>/subagents.json`, the legacy package-local `config.json`, then
 * the bundled `config.json.example`. An explicit `agentDir` ignores the pin.
 */
export function subagentConfigCandidates(agentDir?: string): string[] {
  if (agentDir === undefined) {
    const pinned = process.env[SUBAGENT_CONFIG_FILE_ENV];
    if (pinned) return [pinned];
  }
  return [join(agentDir ?? getAgentDir(), USER_CONFIG_FILE), LEGACY_CONFIG_PATH, EXAMPLE_CONFIG_PATH];
}

export interface SubagentConfigFile {
  sourcePath: string;
  config: unknown;
}

/** Read the first existing candidate as the whole config; later candidates are never merged in. */
export function readSubagentConfig(candidates: readonly string[]): SubagentConfigFile {
  for (const sourcePath of candidates) {
    let raw: string;
    try {
      raw = readFileSync(sourcePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      return { sourcePath, config: JSON.parse(raw) as unknown };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSON in subagent config ${sourcePath}: ${detail}`);
    }
  }
  throw new Error(`Missing subagent config. Expected one of: ${candidates.join(", ")}.`);
}

/**
 * Absolute path of the config file this process uses now, for a child's
 * SUBAGENT_CONFIG_FILE_ENV. An inherited pin passes through unchanged.
 * Throws, like the loaders, when that file is missing or invalid.
 */
export function selectedSubagentConfigFile(): string {
  return resolve(readSubagentConfig(subagentConfigCandidates()).sourcePath);
}
