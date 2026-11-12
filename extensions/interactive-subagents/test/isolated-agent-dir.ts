/**
 * Import this first in suites that load index.ts. index.ts reads the subagent
 * config at import time, so the user's real `<agent-dir>/subagents.json`
 * (e.g. icons "nerd") would otherwise change test expectations. Pointing
 * PI_CODING_AGENT_DIR at a temp dir holding the bundled defaults pins every
 * section, and the whole-file precedence keeps a package-local config.json out.
 * A config pin inherited from a parent Pi session is dropped for the same reason.
 */
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXAMPLE_CONFIG_PATH, SUBAGENT_CONFIG_FILE_ENV, USER_CONFIG_FILE } from "../pi-extension/subagents/config.ts";

const agentDir = mkdtempSync(join(tmpdir(), "pi-subagents-test-agent-"));
copyFileSync(EXAMPLE_CONFIG_PATH, join(agentDir, USER_CONFIG_FILE));
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env[SUBAGENT_CONFIG_FILE_ENV];
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
