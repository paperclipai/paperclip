import { spawnSync } from "node:child_process";
import { invocationEnv } from "./record.mjs";

const [framework, command, ...args] = process.argv.slice(2);
if (!["vitest", "playwright"].includes(framework) || !command) throw new Error("Provide a framework and test command");
const result = spawnSync(command, args, { stdio: "inherit", env: invocationEnv(framework) });
if (result.error) console.error(result.error.message);
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
