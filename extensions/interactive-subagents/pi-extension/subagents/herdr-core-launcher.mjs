/** Apply a per-child environment without a shell or hc --env support. */
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const descriptor = process.argv[2];
const { argv, env, moduleEntryPoint } = JSON.parse(readFileSync(descriptor, "utf8"));
const cleanup = () => rmSync(dirname(descriptor), { recursive: true, force: true });
process.on("exit", cleanup);
Object.assign(process.env, env);
rmSync(descriptor);

if (moduleEntryPoint) {
  // Pi runs in this process with its terminal intact. Long prompts never enter a Windows command line.
  process.argv = argv;
  await import(pathToFileURL(moduleEntryPoint).href);
} else {
  const child = spawn(argv[0], argv.slice(1), { env: process.env, stdio: "inherit", windowsHide: true });
  child.on("error", (error) => { console.error(error.message); process.exit(1); });
  child.on("exit", (code, signal) => { process.exit(signal ? 1 : code ?? 1); });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => { child.kill(signal); });
  }
}
