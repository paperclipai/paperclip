import { describe, expect, it } from "vitest";
import { formatDelegatedPermissions, getSeatPermissionOptions, parseDelegatedPermissions } from "./seat-permissions";

describe("seat permission helpers", () => {
  it("formats delegated permissions as comma-separated text", () => {
    expect(formatDelegatedPermissions(["tasks:assign", "users:invite"])).toBe("tasks:assign, users:invite");
  });

  it("parses delegated permissions, trimming and deduplicating entries", () => {
    expect(parseDelegatedPermissions(" tasks:assign, users:invite, tasks:assign ,, ")).toEqual([
      "tasks:assign",
      "users:invite",
    ]);
  });

  it("exposes permission options from shared constants", () => {
    const seatPermissionOptions = getSeatPermissionOptions();
    expect(seatPermissionOptions.some((option) => option.key === "tasks:assign")).toBe(true);
    expect(seatPermissionOptions.some((option) => option.key === "users:invite")).toBe(true);
    expect(seatPermissionOptions.find((option) => option.key === "tasks:assign_scope")?.label).toBe("Assign tasks in scope");
  });
});
