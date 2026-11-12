import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSubagentConfig, selectedSubagentConfigFile, subagentConfigCandidates } from "../pi-extension/subagents/config.ts";
import { loadCapacityLimit } from "../pi-extension/subagents/capacity.ts";
import { loadProactiveCompactionConfig } from "../pi-extension/subagents/proactive-compaction.ts";
import { loadStatusConfig } from "../pi-extension/subagents/status.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagent-config-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Run with exactly these values (undefined deletes), then restore the previous ones. */
function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (next: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(values);
  try { run(); } finally { apply(saved); }
}

/** Unpinned: resolution follows PI_CODING_AGENT_DIR. */
function withAgentDir(value: string | undefined, run: () => void): void {
  withEnv({ PI_CODING_AGENT_DIR: value, PI_SUBAGENT_CONFIG_FILE: undefined }, run);
}

/** Run from `dir` so relative paths really are relative to it. */
function withCwd(dir: string, run: () => void): void {
  const saved = process.cwd();
  process.chdir(dir);
  try { run(); } finally { process.chdir(saved); }
}

function writeJson(path: string, value: unknown): string {
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("subagent config file precedence", () => {
  it("uses the whole user file over legacy and example files", () => {
    withTempDir((dir) => {
      const user = writeJson(join(dir, "subagents.json"), { status: { enabled: false } });
      const legacy = writeJson(join(dir, "config.json"), { limits: { maxConcurrent: 2 } });
      const example = writeJson(join(dir, "config.json.example"), { limits: { maxConcurrent: 3 } });

      assert.deepEqual(readSubagentConfig([user, legacy, example]), {
        sourcePath: user,
        config: { status: { enabled: false } },
      });
    });
  });

  it("falls back to the legacy file, then the example, only when earlier files are missing", () => {
    withTempDir((dir) => {
      const user = join(dir, "subagents.json");
      const legacy = join(dir, "config.json");
      const example = writeJson(join(dir, "config.json.example"), { limits: { maxConcurrent: 3 } });

      assert.equal(readSubagentConfig([user, legacy, example]).sourcePath, example);
      writeJson(legacy, { limits: { maxConcurrent: 2 } });
      assert.equal(readSubagentConfig([user, legacy, example]).sourcePath, legacy);
    });
  });

  it("reports malformed JSON in the selected file instead of falling back", () => {
    withTempDir((dir) => {
      const user = join(dir, "subagents.json");
      writeFileSync(user, "{ not json");
      const example = writeJson(join(dir, "config.json.example"), {});
      assert.throws(
        () => readSubagentConfig([user, example]),
        (error: Error) => error.message.startsWith(`Invalid JSON in subagent config ${user}:`),
      );
    });
  });

  it("reports an unreadable selected file instead of falling back", () => {
    withTempDir((dir) => {
      const user = join(dir, "subagents.json");
      mkdirSync(user);
      const example = writeJson(join(dir, "config.json.example"), {});
      assert.throws(() => readSubagentConfig([user, example]), { code: "EISDIR" });
    });
  });

  it("names every expected path when no config file exists", () => {
    withTempDir((dir) => {
      const user = join(dir, "subagents.json");
      const example = join(dir, "config.json.example");
      assert.throws(
        () => readSubagentConfig([user, example]),
        (error: Error) => error.message.includes(user) && error.message.includes(example),
      );
    });
  });
});

describe("default subagent config locations", () => {
  it("reads PI_CODING_AGENT_DIR when called, then the package legacy file and example", () => {
    const first = join(tmpdir(), "agent-dir-a");
    const second = join(tmpdir(), "agent-dir-b");
    withAgentDir(first, () => {
      assert.deepEqual(subagentConfigCandidates(), [
        join(first, "subagents.json"),
        join(PACKAGE_ROOT, "config.json"),
        join(PACKAGE_ROOT, "config.json.example"),
      ]);
    });
    withAgentDir(second, () => {
      assert.equal(subagentConfigCandidates()[0], join(second, "subagents.json"));
    });
  });

  it("uses Pi's default agent directory when PI_CODING_AGENT_DIR is unset", () => {
    withAgentDir(undefined, () => {
      assert.equal(subagentConfigCandidates()[0], join(homedir(), ".pi", "agent", "subagents.json"));
    });
  });
});

describe("section loaders", () => {
  it("load status, limits and proactive compaction from the same user subagents.json", () => {
    withTempDir((agentDir) => {
      writeJson(join(agentDir, "subagents.json"), {
        status: { enabled: true, icons: "nerd", profileIcons: false },
        limits: { maxConcurrent: 7 },
        proactiveCompaction: { enabled: false, thresholdPercent: 55 },
      });
      withAgentDir(agentDir, () => {
        assert.deepEqual(loadStatusConfig(), { enabled: true, icons: "nerd", profileIcons: false, lineLimit: 4 });
        assert.equal(loadCapacityLimit(), 7);
        assert.deepEqual(loadProactiveCompactionConfig(), { enabled: false, thresholdPercent: 55 });
      });
    });
  });

  it("read only explicitly injected paths, ignoring the user subagents.json", () => {
    withTempDir((dir) => {
      writeJson(join(dir, "subagents.json"), {
        status: { enabled: false, icons: "nerd" },
        limits: { maxConcurrent: 9 },
        proactiveCompaction: { enabled: false },
      });
      const injected = writeJson(join(dir, "injected.json"), {
        status: { enabled: true, icons: "ascii" },
        limits: { maxConcurrent: 2 },
        proactiveCompaction: { thresholdPercent: 40 },
      });
      const example = join(dir, "missing.example");
      withAgentDir(dir, () => {
        assert.equal(loadStatusConfig(injected, example).icons, "ascii");
        assert.equal(loadCapacityLimit([injected]), 2);
        assert.deepEqual(loadProactiveCompactionConfig([injected]), { enabled: true, thresholdPercent: 40 });
      });
    });
  });
});

describe("config pinned by a parent", () => {
  const parentConfig = {
    status: { enabled: true, icons: "nerd", profileIcons: false },
    limits: { maxConcurrent: 3 },
    proactiveCompaction: { enabled: false, thresholdPercent: 55 },
  };
  const childConfig = {
    status: { enabled: false, icons: "ascii" },
    limits: { maxConcurrent: 9 },
    proactiveCompaction: { enabled: true, thresholdPercent: 90 },
  };

  it("keeps all three sections on the pinned file when the child's agent directory has its own subagents.json", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "parent"));
      mkdirSync(join(dir, "child"));
      const pinned = writeJson(join(dir, "parent", "subagents.json"), parentConfig);
      writeJson(join(dir, "child", "subagents.json"), childConfig);
      withEnv({ PI_CODING_AGENT_DIR: join(dir, "child"), PI_SUBAGENT_CONFIG_FILE: pinned }, () => {
        assert.deepEqual(loadStatusConfig(), { enabled: true, icons: "nerd", profileIcons: false, lineLimit: 4 });
        assert.equal(loadCapacityLimit(), 3);
        assert.deepEqual(loadProactiveCompactionConfig(), { enabled: false, thresholdPercent: 55 });
      });
    });
  });

  it("fails on a malformed or missing pinned file instead of using the agent directory's file", () => {
    withTempDir((dir) => {
      writeJson(join(dir, "subagents.json"), childConfig);
      const pinned = join(dir, "pinned.json");
      withEnv({ PI_CODING_AGENT_DIR: dir, PI_SUBAGENT_CONFIG_FILE: pinned }, () => {
        assert.throws(() => loadStatusConfig(), (error: Error) => error.message.includes(pinned));
        writeFileSync(pinned, "{ not json");
        assert.throws(
          () => loadProactiveCompactionConfig(),
          (error: Error) => error.message.startsWith(`Invalid JSON in subagent config ${pinned}:`),
        );
      });
    });
  });

  it("leaves explicitly injected paths and agent directories unaffected by the pin", () => {
    withTempDir((dir) => {
      const pinned = writeJson(join(dir, "pinned.json"), parentConfig);
      const injected = writeJson(join(dir, "injected.json"), childConfig);
      withEnv({ PI_SUBAGENT_CONFIG_FILE: pinned }, () => {
        assert.equal(loadStatusConfig(injected, join(dir, "missing.example")).icons, "ascii");
        assert.equal(loadCapacityLimit([injected]), 9);
        assert.deepEqual(loadProactiveCompactionConfig([injected]), { enabled: true, thresholdPercent: 90 });
        assert.equal(subagentConfigCandidates(dir)[0], join(dir, "subagents.json"));
      });
    });
  });

  it("selects the file a child should inherit as an absolute path", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "agent"));
      writeJson(join(dir, "agent", "subagents.json"), parentConfig);
      withCwd(dir, () => withAgentDir("agent", () => {
        assert.equal(subagentConfigCandidates()[0], join("agent", "subagents.json"));
        assert.equal(selectedSubagentConfigFile(), join(process.cwd(), "agent", "subagents.json"));
        assert.ok(isAbsolute(selectedSubagentConfigFile()));
      }));
    });
  });

  it("keeps an inherited pin for grandchildren, resolving a relative pin to an absolute path", () => {
    withTempDir((dir) => {
      const pinned = writeJson(join(dir, "pinned.json"), parentConfig);
      writeJson(join(dir, "subagents.json"), childConfig);
      withEnv({ PI_CODING_AGENT_DIR: dir, PI_SUBAGENT_CONFIG_FILE: pinned }, () => {
        assert.equal(selectedSubagentConfigFile(), pinned);
      });
      withCwd(dir, () => withEnv({ PI_CODING_AGENT_DIR: dir, PI_SUBAGENT_CONFIG_FILE: "pinned.json" }, () => {
        assert.equal(selectedSubagentConfigFile(), join(process.cwd(), "pinned.json"));
      }));
    });
  });
});
