import { readFileSync } from "node:fs";

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}

export function processStartTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterComm = stat.indexOf(")");
    if (afterComm === -1) return null;
    const fields = stat.slice(afterComm + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

export function isProcessAliveWithIdentity(
  pid: number,
  expectedStartTicks: string | null,
): boolean {
  if (!processIsAlive(pid)) return false;
  if (!expectedStartTicks) return true;
  const actual = processStartTicks(pid);
  if (!actual) return true;
  return actual === expectedStartTicks;
}
