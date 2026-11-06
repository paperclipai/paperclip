import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NATIVE_CONTINUITY_ARCHIVE_ENTRY, NATIVE_CONTINUITY_STATE_ENTRIES, NATIVE_SESSION_ROOT_HELD_ENTRIES,
  NATIVE_SESSION_ROOT_LAUNCH_ENTRIES, describeUnexpectedNativeSessionRootEntries, isKnownNativeSessionRootEntry,
} from "./native-session-root-entries.js";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// Each writer that targets a native session's durable state root, with the
// expression naming that root in the file. A new top-level entry written by
// any of them must be classified before retirement can see it.
const WRITERS: Array<{ file: string; root: string }> = [
  { file: "./native-session-executor.ts", root: "root|scoped|input\\.root" },
  { file: "./cursor-cloud-runtime.ts", root: "input\\.root" },
  { file: "../../../../packages/paperclip-runner/src/live/runnerd-codex-transport.ts", root: "this\\.#root|root" },
  { file: "../../../../packages/paperclip-runner/src/live/runner-launch-preparation-store.ts", root: "directory" },
];

function writtenRootEntries(): Set<string> {
  const names = new Set<string>();
  for (const writer of WRITERS) {
    const pattern = new RegExp(`(?:resolve|join)\\((?:${writer.root}), "([^"/]+)"`, "g");
    for (const match of source(writer.file).matchAll(pattern)) names.add(match[1]!);
  }
  // Root entries named through constants rather than literal path segments.
  for (const [file, constant] of [
    ["./native-session-executor.ts", /const CLEANUP_ACTIVATION_FILE = "([^"]+)"/],
    ["./remote-provider-pack-authority.ts", /const filename = "([^"]+)"/],
  ] as const) {
    const match = constant.exec(source(file));
    expect(match, `${file} root entry constant`).not.toBeNull();
    names.add(match![1]!);
  }
  return names;
}

describe("native session root entry contract", () => {
  it("classifies every entry a known writer puts in the session root", () => {
    const written = writtenRootEntries();
    // Guard the scan itself: these writers exist today.
    for (const name of ["control-plane", "runtime-context.json", "authority-epochs", "launch-preparation.json",
      "provider-pack-authority.json", "cleanup-activation.json", "plugin-runner-state.json"]) {
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
