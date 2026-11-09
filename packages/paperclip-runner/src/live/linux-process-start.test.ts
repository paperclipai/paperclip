import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { readLinuxProcessStartedAt } from "./linux-process-start.js";

const stat = (ticks: string, command = "runner") => `123 (${command}) S ${Array(18).fill("0").join(" ")} ${ticks}\n`;
const options = (processStat = stat("123"), systemStat = "btime 1785546000\n", clockTicksPerSecond = 100) => ({
  clockTicksPerSecond,
  readFile: (path: string) => path === "/proc/123/stat" ? processStat : systemStat,
});

it("uses kernel birth ticks even when the command contains spaces and parentheses", () => {
  expect(readLinuxProcessStartedAt(123, options(stat("123", "a ) b ( c"))))
    .toBe(new Date(1785546001230).toISOString());
  expect(readLinuxProcessStartedAt(123, options(stat("124"))))
    .not.toBe(readLinuxProcessStartedAt(123, options()));
});

it.each([
  [stat("bad"), "btime 1785546000\n", 100],
  [stat("123").replace("123 (", "124 ("), "btime 1785546000\n", 100],
  ["123 (runner) S", "btime 1785546000\n", 100],
  [stat("123"), "btime invalid\n", 100],
  [stat("123"), "btime 1785546000\n", 0],
  [stat("123"), "btime 1785546000\n", Number.NaN],
  [stat("123"), "btime 999999999999999999999\n", 100],
])("fails closed on malformed birth metadata or clock frequency", (processStat, systemStat, frequency) => {
  expect(() => readLinuxProcessStartedAt(123, options(processStat, systemStat, frequency))).toThrow();
});

it.skipIf(process.platform !== "linux")("keeps the actual owned child's birth identity stable through a delayed observation", async () => {
  const child = spawn("/bin/sleep", ["10"], { stdio: "ignore" });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  try {
    expect(child.pid).toBeGreaterThan(0);
    const first = readLinuxProcessStartedAt(child.pid!);
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(readLinuxProcessStartedAt(child.pid!)).toBe(first);
    child.kill("SIGTERM"); await closed;
    expect(() => readLinuxProcessStartedAt(child.pid!)).toThrow();
  } finally { child.kill("SIGTERM"); await closed; }
}, 5000);
