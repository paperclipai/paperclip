// Central wrappers around Node's child_process spawn family that default
// `windowsHide: true` so child processes never flash a console window on
// Windows (TEN-157 / TEN-166). The flag is a no-op on macOS/Linux, so these
// are safe to use everywhere.
//
// IMPORTANT: this module pulls in `node:child_process` and must therefore stay
// OUT of the browser-safe root barrel (see ./index.ts). Import it directly from
// server-side call sites: `import { spawnHidden } from "./spawn-hidden.js"`.
//
// Each wrapper preserves the exact type of the underlying child_process
// function (all overloads) and only injects the default; an explicitly provided
// `windowsHide` value is never overridden.
import {
  spawn,
  spawnSync,
  execFile,
  execFileSync,
  fork,
} from "node:child_process";

/**
 * Inject `windowsHide: true` into the options object of a child_process call,
 * regardless of which argument position it occupies, without overriding an
 * explicit value and without mutating the caller's object.
 */
function withWindowsHide(args: readonly unknown[]): unknown[] {
  const a = args.slice();
  let optionsIndex = -1;
  for (let i = a.length - 1; i >= 0; i--) {
    const value = a[i];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      optionsIndex = i;
      break;
    }
  }
  if (optionsIndex === -1) {
    // No options object present. Insert one before a trailing callback if any.
    const options = { windowsHide: true };
    if (a.length > 0 && typeof a[a.length - 1] === "function") {
      a.splice(a.length - 1, 0, options);
    } else {
      a.push(options);
    }
  } else if (!("windowsHide" in (a[optionsIndex] as object))) {
    a[optionsIndex] = { ...(a[optionsIndex] as object), windowsHide: true };
  }
  return a;
}

/** `child_process.spawn` with `windowsHide: true` defaulted. */
export const spawnHidden = ((...args: Parameters<typeof spawn>) =>
  (spawn as (...a: unknown[]) => ReturnType<typeof spawn>)(
    ...withWindowsHide(args),
  )) as typeof spawn;

/** `child_process.spawnSync` with `windowsHide: true` defaulted. */
export const spawnSyncHidden = ((...args: Parameters<typeof spawnSync>) =>
  (spawnSync as (...a: unknown[]) => ReturnType<typeof spawnSync>)(
    ...withWindowsHide(args),
  )) as typeof spawnSync;

/** `child_process.execFile` with `windowsHide: true` defaulted. */
export const execFileHidden = ((...args: Parameters<typeof execFile>) =>
  (execFile as (...a: unknown[]) => ReturnType<typeof execFile>)(
    ...withWindowsHide(args),
  )) as typeof execFile;

/** `child_process.execFileSync` with `windowsHide: true` defaulted. */
export const execFileSyncHidden = ((...args: Parameters<typeof execFileSync>) =>
  (execFileSync as (...a: unknown[]) => ReturnType<typeof execFileSync>)(
    ...withWindowsHide(args),
  )) as typeof execFileSync;

/** `child_process.fork` with `windowsHide: true` defaulted. */
export const forkHidden = ((...args: Parameters<typeof fork>) =>
  (fork as (...a: unknown[]) => ReturnType<typeof fork>)(
    ...withWindowsHide(args),
  )) as typeof fork;
