import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NATIVE_CONTINUITY_ARCHIVE_ENTRY, NATIVE_CONTINUITY_STATE_ENTRIES, NATIVE_SESSION_ROOT_HELD_ENTRIES,
  NATIVE_SESSION_ROOT_LAUNCH_ENTRIES, describeUnexpectedNativeSessionRootEntries, isKnownNativeSessionRootEntry,
} from "./native-session-root-entries.js";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\#]/g, "\\$&");

// Each module that writes a native session's durable state root, with the
// expressions naming that root in the file. A new top-level entry written by
// any of them must be classified before retirement can see it.
const WRITERS: Array<{ file: string; roots: string[]; dynamic?: string[] }> = [
  // Dynamic arguments iterate over classified lists: continuity moves and
  // cleanup/recovery reads of control-plane and runner files.
  { file: "./native-session-executor.ts", roots: ["root", "scoped", "input.root"], dynamic: ["file", "name", "directory"] },
  { file: "./cursor-cloud-runtime.ts", roots: ["input.root"] },
  { file: "./remote-provider-pack-authority.ts", roots: ["input.stateDirectory"] },
  { file: "./native-controller-migration.ts", roots: ["paths.root"] },
  { file: "../../../../packages/paperclip-runner/src/live/runnerd-codex-transport.ts", roots: ["this.#root", "root"],
    dynamic: ["file"] },
  { file: "../../../../packages/paperclip-runner/src/live/runner-launch-preparation-store.ts", roots: ["directory"] },
];

/**
 * Every top-level entry a writer names: string and template literals (their
 * leading segment) and identifiers resolved through a same-file string
 * constant, across resolve/join/posix.join/path.join. Any other identifier
 * must be listed as dynamic, so a writer that reaches the root through a new
 * variable fails here instead of passing silently.
 */
function writtenRootEntries(): { names: Set<string>; unresolved: string[] } {
  const names = new Set<string>();
  const unresolved: string[] = [];
  for (const writer of WRITERS) {
    const text = source(writer.file);
    const roots = writer.roots.map(escape).join("|");
    const call = new RegExp(`(?:\\bresolve|(?:\\bposix\\.|\\bpath\\.|\\b)join)\\((?:${roots}),\\s*([^,)]+)`, "g");
    for (const [, raw] of text.matchAll(call)) {
      const argument = raw!.trim();
      const literal = /^["'`]([^"'`/$]+)/.exec(argument);
      if (literal) {
        names.add(literal[1]!);
        continue;
      }
      const identifier = /^[A-Za-z_$][\w$.]*$/.exec(argument)?.[0];
      const constant = identifier
        ? new RegExp(`const ${escape(identifier)} = ["'\`]([^"'\`/]+)["'\`]`).exec(text)
        : null;
      if (constant) {
        names.add(constant[1]!);
        continue;
      }
      if (identifier && writer.dynamic?.includes(identifier.split(".")[0]!)) continue;
      unresolved.push(`${writer.file}: ${argument}`);
    }
  }
  // Harness persistence directories are restored into the root by name.
  for (const [, name] of source("./native-session-executor.ts").matchAll(/name: "([^"]+)",\s*location: "filesystem"/g)) {
    names.add(name!);
  }
  return { names, unresolved };
}

describe("native session root entry contract", () => {
  it("classifies every entry a known writer puts in the session root", () => {
    const { names: written, unresolved } = writtenRootEntries();
    expect(unresolved).toEqual([]);
    // Guard the scan itself: these writers exist today.
    for (const name of ["control-plane", "runner", "runtime-context.json", "authority-epochs", "launch-preparation.json",
      "provider-pack-authority.json", "cleanup-activation.json", "plugin-runner-state.json", "codex-home", "opencode",
      "acpx", "cursor-cloud", "diagnostics", "failover-backups", "continuity-breaks"]) {
      expect(written).toContain(name);
    }
    const unclassified = [...written].filter(name => !isKnownNativeSessionRootEntry(name) &&
      !NATIVE_SESSION_ROOT_HELD_ENTRIES.includes(name));
    expect(unclassified).toEqual([]);
  });

  it("keeps the classes disjoint so an entry has one retirement meaning", () => {
    const all = [...NATIVE_CONTINUITY_STATE_ENTRIES, ...NATIVE_SESSION_ROOT_LAUNCH_ENTRIES,
      ...NATIVE_SESSION_ROOT_HELD_ENTRIES, NATIVE_CONTINUITY_ARCHIVE_ENTRY];
    expect(new Set(all).size).toBe(all.length);
    for (const held of NATIVE_SESSION_ROOT_HELD_ENTRIES) expect(isKnownNativeSessionRootEntry(held)).toBe(false);
  });

  it("names unexpected entries in a bounded, redacted form", () => {
    expect(describeUnexpectedNativeSessionRootEntries(["unrecognized-state"])).toBe("unrecognized-state");
    expect(describeUnexpectedNativeSessionRootEntries([".state.123e4567-e89b-12d3-a456-426614174000.tmp"]))
      .toBe(".state.<id>.tmp");
    expect(describeUnexpectedNativeSessionRootEntries(["has space", "a/b", "x".repeat(65)])).toBe("other");
    expect(describeUnexpectedNativeSessionRootEntries(["d", "c", "b", "a"])).toBe("a,b,c,+1");
  });
});
