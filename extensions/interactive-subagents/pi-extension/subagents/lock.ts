import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";

export interface ExclusiveFile {
  path: string;
  fd: number;
}

function pidContent(): string {
  return `${JSON.stringify({ pid: process.pid })}\n`;
}

export function createExclusiveFile(path: string, content = pidContent()): ExclusiveFile {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, content);
  } catch (error) {
    reportCleanupErrors(path, releaseExclusiveFile({ path, fd }));
    throw error;
  }
  return { path, fd };
}

export function releaseExclusiveFile(file: ExclusiveFile): unknown[] {
  const errors: unknown[] = [];
  try { closeSync(file.fd); } catch (error) { errors.push(error); }
  try {
    unlinkSync(file.path);
  } catch (error: any) {
    if (error?.code !== "ENOENT") errors.push(error);
  }
  return errors;
}

export function reportCleanupErrors(path: string, errors: unknown[]): void {
  for (const error of errors) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[interactive-subagents] Could not clean up lock ${path}: ${message}`);
  }
}

export function withExclusiveFile<T>(file: ExclusiveFile, action: () => T): T {
  try {
    return action();
  } finally {
    reportCleanupErrors(file.path, releaseExclusiveFile(file));
  }
}

export function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}
