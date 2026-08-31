import { describe, expect, it } from "vitest";

import { safeAcpxLocations } from "./acpx-sidecar-locations.js";

describe("ACPX sidecar locations", () => {
  it("preserves valid host-relative display names without admitting escape", () => {
    expect(
      safeAcpxLocations(
        [
          { path: "src/main.ts", line: 4 },
          { path: "reports/100%/summary.txt" },
          { path: "../outside.txt" },
          { path: "/etc/passwd" },
          { uri: "https://example.test/private" },
          { path: "bad\0name" },
        ],
        "/workspace/project",
      ),
    ).toEqual([
      {
        path: "src/main.ts",
        line: 4,
        pathBoundary: "paperclip.workspace_relative_display.v1",
      },
      {
        path: "reports/100%/summary.txt",
        line: null,
        pathBoundary: "paperclip.workspace_relative_display.v1",
      },
    ]);
  });

  it.runIf(process.platform !== "win32")(
    "preserves POSIX literal colon and backslash filename characters",
    () => {
      expect(
        safeAcpxLocations(
          [{ path: "src:main.ts" }, { path: String.raw`folder\literal` }],
          "/workspace/project",
        ),
      ).toEqual([
        {
          path: "src:main.ts",
          line: null,
          pathBoundary: "paperclip.workspace_relative_display.v1",
        },
        {
          path: String.raw`folder\literal`,
          line: null,
          pathBoundary: "paperclip.workspace_relative_display.v1",
        },
      ]);
    },
  );

  it("omits every location until the session working directory is bound", () => {
    expect(safeAcpxLocations([{ path: "src/main.ts" }], undefined)).toEqual([]);
  });
});
