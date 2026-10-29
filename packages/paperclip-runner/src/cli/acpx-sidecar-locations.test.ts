import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { safeAcpxLocations } from "./acpx-sidecar-locations.js";

describe("ACPX sidecar locations", () => {
  it.runIf(sep === "/")(
    "preserves valid host-relative display names without admitting escape",
    () => {
      const workspace = mkdtempSync(
        join(tmpdir(), "paperclip-acpx-locations-"),
      );
      writeFileSync(join(workspace, "src:main.ts"), "");
      mkdirSync(join(workspace, "a:"));
      writeFileSync(join(workspace, "a:", "foo"), "");
      writeFileSync(join(workspace, "custom:payload"), "");
      try {
        expect(
          safeAcpxLocations(
            [
              { path: "src/main.ts", line: 4 },
              { path: "src:main.ts" },
              { path: String.raw`folder\literal` },
              { path: "a:/foo" },
              { path: "custom:payload" },
              { path: String.raw`foo\..\bar` },
              { path: "reports/100%/summary.txt" },
              { path: "../outside.txt" },
              { path: "/etc/passwd" },
              { uri: "https://example.test/private" },
              { path: "bad\0name" },
            ],
            workspace,
          ),
        ).toEqual([
          {
            path: "src/main.ts",
            line: 4,
            pathBoundary: "paperclip.workspace_relative_display.v2",
          },
          {
            path: "src:main.ts",
            line: null,
            pathBoundary: "paperclip.workspace_relative_display.v2",
            pathAttestation: "paperclip.workspace_entry.v1",
          },
          {
            path: String.raw`folder\literal`,
            line: null,
            pathBoundary: "paperclip.workspace_relative_display.v2",
          },
          {
            path: "a:/foo",
            line: null,
            pathBoundary: "paperclip.workspace_relative_display.v2",
            pathAttestation: "paperclip.workspace_entry.v1",
          },
          {
            path: "custom:payload",
            line: null,
            pathBoundary: "paperclip.workspace_relative_display.v2",
            pathAttestation: "paperclip.workspace_entry.v1",
          },
          {
            path: String.raw`foo\..\bar`,
            line: null,
            pathBoundary: "paperclip.workspace_relative_display.v2",
          },
          {
            path: "reports/100%/summary.txt",
            line: null,
            pathBoundary: "paperclip.workspace_relative_display.v2",
          },
        ]);
      } finally {
        rmSync(workspace, { force: true, recursive: true });
      }
    },
  );

  it.runIf(sep === "/")(
    "attests a leading backslash as valid POSIX filename data",
    () => {
      const workspace = mkdtempSync(
        join(tmpdir(), "paperclip-acpx-locations-"),
      );
      writeFileSync(join(workspace, String.raw`\notes.md`), "");
      try {
        expect(
          safeAcpxLocations([{ path: String.raw`\notes.md` }], workspace),
        ).toEqual([
          {
            path: String.raw`\notes.md`,
            line: null,
            pathBoundary: "paperclip.workspace_relative_display.v2",
            pathAttestation: "paperclip.workspace_entry.v1",
          },
        ]);
      } finally {
        rmSync(workspace, { force: true, recursive: true });
      }
    },
  );

  it("rejects URI and foreign-host syntax before attaching the boundary", () => {
    expect(
      safeAcpxLocations(
        [
          { path: String.raw`C:\Users\alice\secret.txt` },
          { path: String.raw`\\server\share\secret.txt` },
          { path: String.raw`https:\host\secret` },
          { path: "https://host/secret" },
          { path: "file:secret.txt" },
          { path: "s3:bucket/key" },
          { path: "custom:payload" },
          { path: "urn:isbn:9780131103627" },
          { path: "tel:+15555550100" },
          { path: String.raw`C:Users\alice\secret.txt` },
          { path: "D:relative.txt" },
        ],
        tmpdir(),
      ),
    ).toEqual([]);
  });

  it.runIf(sep === "/")(
    "attests scheme-shaped targets after relative and absolute normalization",
    () => {
      const workspace = mkdtempSync(
        join(tmpdir(), "paperclip-acpx-locations-"),
      );
      const entry = join(workspace, "src:main.ts");
      writeFileSync(entry, "");
      try {
        expect(
          safeAcpxLocations(
            [{ path: "./src:main.ts" }, { path: resolve(entry) }],
            workspace,
          ),
        ).toEqual([
          {
            path: "src:main.ts",
            line: null,
            pathBoundary: "paperclip.workspace_relative_display.v2",
            pathAttestation: "paperclip.workspace_entry.v1",
          },
          {
            path: "src:main.ts",
            line: null,
            pathBoundary: "paperclip.workspace_relative_display.v2",
            pathAttestation: "paperclip.workspace_entry.v1",
          },
        ]);
      } finally {
        rmSync(workspace, { force: true, recursive: true });
      }
    },
  );

  it.runIf(sep === "/")(
    "attests missing edit targets without weakening symlink containment",
    () => {
      const root = mkdtempSync(join(tmpdir(), "paperclip-acpx-locations-"));
      const workspace = join(root, "workspace");
      const outside = join(root, "outside");
      mkdirSync(workspace);
      mkdirSync(outside);
      symlinkSync(outside, join(workspace, "src:"));
      symlinkSync(
        join(workspace, "missing"),
        join(workspace, "dangling:new.ts"),
      );
      try {
        expect(
          safeAcpxLocations(
            [
              { path: "src:new.ts", line: 8 },
              { path: "src:/outside.ts" },
              { path: "dangling:new.ts" },
              { path: "missing:/nested.ts" },
            ],
            workspace,
            "edit",
          ),
        ).toEqual([
          {
            path: "src:new.ts",
            line: 8,
            pathBoundary: "paperclip.workspace_relative_display.v2",
            pathAttestation: "paperclip.workspace_create_target.v1",
          },
        ]);
        expect(
          safeAcpxLocations([{ path: "src:new.ts" }], workspace, "read"),
        ).toEqual([]);
        expect(
          safeAcpxLocations(
            [{ path: "src:new.ts" }],
            workspace,
            undefined,
            "Write",
          ),
        ).toHaveLength(1);
        for (const compoundKind of ["read_write", "search_write"]) {
          expect(
            safeAcpxLocations(
              [{ path: "src:new.ts" }],
              workspace,
              compoundKind,
            ),
          ).toEqual([
            {
              path: "src:new.ts",
              line: null,
              pathBoundary: "paperclip.workspace_relative_display.v2",
              pathAttestation: "paperclip.workspace_create_target.v1",
            },
          ]);
        }
        expect(
          safeAcpxLocations(
            [{ path: "src:new.ts" }],
            workspace,
            `${"x".repeat(240)}write`,
          ),
        ).toEqual([
          {
            path: "src:new.ts",
            line: null,
            pathBoundary: "paperclip.workspace_relative_display.v2",
            pathAttestation: "paperclip.workspace_create_target.v1",
          },
        ]);
        // The runtime sidecar sends and classifies this same bounded title. A
        // mutation token beyond the transport boundary must not authorize the
        // otherwise missing create target.
        expect(
          safeAcpxLocations(
            [{ path: "src:new.ts" }],
            workspace,
            undefined,
            `${"x".repeat(4_000)}write`.slice(0, 4_000),
          ),
        ).toEqual([]);
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("omits every location until the session working directory is bound", () => {
    expect(safeAcpxLocations([{ path: "src/main.ts" }], undefined)).toEqual([]);
  });
});
