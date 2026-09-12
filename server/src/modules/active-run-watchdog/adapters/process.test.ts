import { beforeEach, describe, expect, it, vi } from "vitest";
import { runningProcesses } from "../../../adapters/utils.js";
import { isPidAlive, isProcessGroupAlive, terminateLocalService } from "../../../services/local-service-supervisor.js";
import { createProcessAdapter } from "./process.js";

vi.mock("../../../services/local-service-supervisor.js", () => ({
  isPidAlive: vi.fn(),
  isProcessGroupAlive: vi.fn(),
  terminateLocalService: vi.fn(),
}));

const mockedIsPidAlive = vi.mocked(isPidAlive);
const mockedIsProcessGroupAlive = vi.mocked(isProcessGroupAlive);
const mockedTerminateLocalService = vi.mocked(terminateLocalService);

describe("adapters", () => {
  describe("createProcessAdapter", () => {
    beforeEach(() => {
      mockedIsPidAlive.mockReset();
      mockedIsProcessGroupAlive.mockReset();
      mockedTerminateLocalService.mockReset();
      runningProcesses.clear();
    });

    it("reports skipped_non_local_adapter for a non-sessioned adapter type", async () => {
      const adapter = createProcessAdapter();

      const outcome = await adapter.cleanupRunProcess({
        runId: "run-1",
        adapterType: "hermes_gateway",
        fallbackPid: 4242,
        fallbackProcessGroupId: null,
      });

      expect(outcome).toEqual({ attempted: false, outcome: "skipped_non_local_adapter", adapterType: "hermes_gateway" });
      expect(mockedIsPidAlive).not.toHaveBeenCalled();
    });

    it("reports no_process_metadata when no pid or process group is known", async () => {
      const adapter = createProcessAdapter();

      const outcome = await adapter.cleanupRunProcess({
        runId: "run-1",
        adapterType: "codex_local",
        fallbackPid: null,
        fallbackProcessGroupId: null,
      });

      expect(outcome).toEqual({ attempted: false, outcome: "no_process_metadata", adapterType: "codex_local" });
    });

    it("reports not_running when the process is dead", async () => {
      mockedIsPidAlive.mockReturnValue(false);
      mockedIsProcessGroupAlive.mockReturnValue(false);
      const adapter = createProcessAdapter();

      const outcome = await adapter.cleanupRunProcess({
        runId: "run-1",
        adapterType: "codex_local",
        fallbackPid: 4242,
        fallbackProcessGroupId: null,
      });

      expect(outcome).toEqual({
        attempted: false,
        outcome: "not_running",
        adapterType: "codex_local",
        pid: 4242,
        processGroupId: null,
      });
      expect(mockedTerminateLocalService).not.toHaveBeenCalled();
    });

    it("reports terminated when the live process stops after termination", async () => {
      mockedIsPidAlive.mockReturnValueOnce(true).mockReturnValueOnce(false);
      mockedIsProcessGroupAlive.mockReturnValue(false);
      mockedTerminateLocalService.mockResolvedValue(undefined);
      const adapter = createProcessAdapter();

      const outcome = await adapter.cleanupRunProcess({
        runId: "run-1",
        adapterType: "codex_local",
        fallbackPid: 4242,
        fallbackProcessGroupId: null,
      });

      expect(outcome).toEqual({
        attempted: true,
        outcome: "terminated",
        adapterType: "codex_local",
        pid: 4242,
        processGroupId: null,
      });
      expect(mockedTerminateLocalService).toHaveBeenCalledTimes(1);
    });

    it("reports failed when termination throws", async () => {
      mockedIsPidAlive.mockReturnValue(true);
      mockedIsProcessGroupAlive.mockReturnValue(false);
      mockedTerminateLocalService.mockRejectedValue(new Error("kill failed"));
      const adapter = createProcessAdapter();

      const outcome = await adapter.cleanupRunProcess({
        runId: "run-1",
        adapterType: "codex_local",
        fallbackPid: 4242,
        fallbackProcessGroupId: null,
      });

      expect(outcome).toEqual({
        attempted: true,
        outcome: "failed",
        adapterType: "codex_local",
        pid: 4242,
        processGroupId: null,
        error: "kill failed",
      });
    });

    it("uses a valid process group when no pid is available", async () => {
      mockedIsProcessGroupAlive.mockReturnValueOnce(true).mockReturnValueOnce(false);
      mockedTerminateLocalService.mockResolvedValue(undefined);
      const adapter = createProcessAdapter();

      const outcome = await adapter.cleanupRunProcess({
        runId: "run-1",
        adapterType: "codex_local",
        fallbackPid: null,
        fallbackProcessGroupId: 4242,
      });

      expect(outcome).toEqual({
        attempted: true,
        outcome: "terminated",
        adapterType: "codex_local",
        pid: null,
        processGroupId: 4242,
      });
      expect(mockedTerminateLocalService).toHaveBeenCalledWith(
        { pid: 4242, processGroupId: 4242 },
        undefined,
      );
    });

    it.each([
      { fallbackPid: 0, fallbackProcessGroupId: null },
      { fallbackPid: -7, fallbackProcessGroupId: null },
      { fallbackPid: 4.5, fallbackProcessGroupId: null },
      { fallbackPid: null, fallbackProcessGroupId: 0 },
      { fallbackPid: null, fallbackProcessGroupId: -7 },
      { fallbackPid: null, fallbackProcessGroupId: 4.5 },
    ])(
      "reports no_process_metadata for invalid identifiers ($fallbackPid, $fallbackProcessGroupId)",
      async ({ fallbackPid, fallbackProcessGroupId }) => {
        mockedIsPidAlive.mockReturnValue(true);
        mockedIsProcessGroupAlive.mockReturnValue(false);
        mockedTerminateLocalService.mockResolvedValue(undefined);
        const adapter = createProcessAdapter();

        const outcome = await adapter.cleanupRunProcess({
          runId: "run-1",
          adapterType: "codex_local",
          fallbackPid,
          fallbackProcessGroupId,
        });

        expect(outcome).toEqual({
          attempted: false,
          outcome: "no_process_metadata",
          adapterType: "codex_local",
        });
        expect(mockedIsPidAlive).not.toHaveBeenCalled();
        expect(mockedIsProcessGroupAlive).not.toHaveBeenCalled();
        expect(mockedTerminateLocalService).not.toHaveBeenCalled();
      },
    );
  });
});
