import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { UsageError } from "./args.mjs";

export const RESERVED_PORTS = [3100, 3101, 3121, 4173, 5173, 5180, 5190, 6006, 6016];
export const FIRST_DEV_PORT = 5200;
export const PORT_STEP = 20;
export const PREVIEW_OFFSET = 10;

export function launchPorts(root) {
  const file = path.join(root, ".claude/launch.json");
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return (parsed.configurations ?? []).map((entry) => Number(entry.port)).filter((port) => Number.isFinite(port));
}

export function cacheDirPorts(root) {
  const dir = path.join(root, "ui/node_modules");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => /^\.vite-.+-(\d+)$/.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]));
}

export function takenPorts(root) {
  return new Set([...RESERVED_PORTS, ...launchPorts(root), ...cacheDirPorts(root)]);
}

export function pickPorts(root, explicit) {
  const taken = takenPorts(root);
  if (explicit) {
    const parts = explicit.split(",").map((part) => Number(part.trim()));
    if (parts.length !== 2 || parts.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535)) throw new UsageError("--ports must be dev,preview (two ports between 1024 and 65535)");
    const [dev, preview] = parts;
    if (dev === preview) throw new UsageError("--ports dev and preview must differ");
    const clashes = parts.filter((port) => taken.has(port));
    if (clashes.length) throw new UsageError(`--ports ${clashes.join(", ")} already taken (launch.json, reserved list or a .vite-*-<port> cache dir)`);
    return { dev, preview };
  }
  for (let dev = FIRST_DEV_PORT; dev < 65000; dev += PORT_STEP) {
    const preview = dev + PREVIEW_OFFSET;
    if (!taken.has(dev) && !taken.has(preview)) return { dev, preview };
  }
  throw new UsageError("no free port pair found");
}
