import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Db } from "@paperclipai/db";
const log = vi.hoisted(() => vi.fn());
vi.mock("../heartbeat-run-events.js", () => ({ appendHeartbeatRunEvent: log }));
import { restoreNativeWorkspaceBestEffort } from "./native-workspace-best-effort.js";

function fixture() {
  const limit = vi.fn(async () => [{ companyId: "company", agentId: "agent" }]);
  const db = { select: vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) })) };
  return { db: db as unknown as Db, select: db.select, limit };
}

describe("best effort native workspace export", () => {
  beforeEach(() => log.mockReset());

  it("preserves the restore result on success", async () => {
    const { db, select } = fixture();
    await expect(restoreNativeWorkspaceBestEffort({ db, runId: "run", restore: async () => true })).resolves.toBe(true);
    expect(select).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    new Error("Daytona syncOut refusing tarball member that escapes the extraction dir: ../private"),
    new Error("Daytona outbound symlink-escape guard command failed (exit 42): private"),
    Object.assign(new Error("private detail"), { code: "WORKSPACE_RESTORE_UNSAFE_ARCHIVE" }),
  ])("omits unsafe exports with only a redacted info event: %s", async (error) => {
    const { db } = fixture();
    await expect(restoreNativeWorkspaceBestEffort({ db, runId: "run", restore: async () => { throw error; } })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledExactlyOnceWith(db, expect.objectContaining({
      companyId: "company", agentId: "agent", runId: "run", level: "info", eventType: "workspace_export_omitted",
    }));
    expect(JSON.stringify(log.mock.calls[0][1])).not.toContain("private");
  });

  it("does not hide transport failures or ownership loss", async () => {
    const { db, select } = fixture();
    const restore = async () => { throw new Error("transport unavailable"); };
    await expect(restoreNativeWorkspaceBestEffort({ db, runId: "run", restore })).rejects.toThrow("transport unavailable");
    await expect(restoreNativeWorkspaceBestEffort({ db, runId: "run",
      restore: async () => { throw Object.assign(new Error("unsafe"), { code: "WORKSPACE_RESTORE_UNSAFE_ARCHIVE" }); },
      assertOwnership: async () => { throw new Error("ownership lost"); },
    })).rejects.toThrow("ownership lost");
    expect(select).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("does not fail the task when the informational log is unavailable", async () => {
    const { db } = fixture();
    log.mockRejectedValueOnce(new Error("log unavailable"));
    await expect(restoreNativeWorkspaceBestEffort({ db, runId: "run",
      restore: async () => { throw Object.assign(new Error("unsafe"), { code: "WORKSPACE_RESTORE_UNSAFE_ARCHIVE" }); },
    })).resolves.toBeUndefined();
  });
});
