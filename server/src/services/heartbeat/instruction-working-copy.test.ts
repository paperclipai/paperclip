import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHeartbeatInstructionWorkingCopy } from "./instruction-working-copy.js";
import { AGENT_FILES_CONTRACT } from "../agent-file-store.js";
import { AgentDirectoryReuseInvalidatedError } from "../agent-directory-working-copies.js";

const native = vi.hoisted(() => ({ reserve: vi.fn(), claim: vi.fn() }));
vi.mock("../native-runtime/index.js", async importOriginal => ({
  ...await importOriginal<typeof import("../native-runtime/index.js")>(),
  reserveWarmNativeInstructionDirectory: native.reserve,
  claimWarmNativeInstructionCopy: native.claim,
}));

type Input = Parameters<typeof createHeartbeatInstructionWorkingCopy>[0];
type Prepare = Parameters<ReturnType<typeof createHeartbeatInstructionWorkingCopy>["prepare"]>[0];
type Copy = NonNullable<Awaited<ReturnType<Input["instructionCopies"]["prepare"]>>>;

function fixture() {
  let run = { id: "current-run", companyId: "company", agentId: "agent", runnerProfileJson: null, status: "queued" } as ReturnType<Input["readRun"]>;
  const copy = { runId: run.id, companyId: run.companyId, agentId: run.agentId,
    localRoot: "/workspace/copy", executionRoot: "/workspace/copy", entryFile: "AGENTS.md",
    state: "prepared", receipt: { schema: AGENT_FILES_CONTRACT, warm: true }, errorCode: null, errorMessage: null,
  } as unknown as Copy;
  const copies = {
    prepare: vi.fn<Input["instructionCopies"]["prepare"]>().mockResolvedValue(copy),
    collectStopped: vi.fn<Input["instructionCopies"]["collectStopped"]>().mockResolvedValue({ ...copy, state: "saved" }),
    checkpointWarm: vi.fn<Input["instructionCopies"]["checkpointWarm"]>().mockResolvedValue({ ...copy, state: "warm_saved", receipt: { ...copy.receipt, checkpointState: "unchanged" } }),
    hasChanges: vi.fn().mockResolvedValue(false), canReuseWarm: vi.fn().mockResolvedValue(true),
    reportRetirementUnconfirmed: vi.fn().mockResolvedValue(null),
  };
  const appendRunEvent = vi.fn().mockResolvedValue(undefined);
  const context = { paperclipWorkspace: { agentHome: "/canonical" } } as Record<string, unknown>;
  const controller = createHeartbeatInstructionWorkingCopy({
    db: {} as Input["db"], instructionCopies: copies as unknown as Input["instructionCopies"],
    readRun: () => run,
    agent: { id: "agent", companyId: "company", adapterType: "codex_local", adapterConfig: { lifecycleMode: "warm" }, runtimeConfig: {} } as unknown as Input["agent"],
    context,
    session: { taskSession: null, taskSessionForRun: { lastRunId: "previous-run" }, sessionConfigMetadata: {} as Input["session"]["sessionConfigMetadata"] },
    workspace: { executionTarget: null, executionWorkspace: { cwd: "/workspace" } as Input["workspace"]["executionWorkspace"], persistedExecutionWorkspace: null },
    appendRunEvent,
  });
  const prepare: Prepare = { runtimeConfig: { retained: true }, hasInstructionFilesystem: true,
    nativeRuntimeResolution: { kind: "native", profile: { backend: "codex_app_server" } } as Prepare["nativeRuntimeResolution"] };
  const reservation = { reuseRunId: "previous-run", adopt: vi.fn(), release: vi.fn().mockResolvedValue(undefined) };
  native.reserve.mockResolvedValue(reservation);
  return { controller, copies, copy, context, prepare, reservation, appendRunEvent,
    replaceRun: () => { run = { ...run, status: "running" }; return run; } };
}

beforeEach(() => { vi.clearAllMocks(); native.claim.mockResolvedValue(null); });

describe("instruction working-copy extraction boundary", () => {
  it("retains a warm reservation for outer cleanup when subsequent preparation throws", async () => {
    const f = fixture();
    f.copies.prepare.mockRejectedValue(new Error("preparation interrupted"));
    await expect(f.controller.prepare(f.prepare)).rejects.toThrow("preparation interrupted");
    expect(f.controller.nativeInstructionReservation).toBe(f.reservation);
    expect(f.controller.instructionCopy).toBeNull();
    await f.controller.nativeInstructionReservation?.release();
    expect(f.reservation.release).toHaveBeenCalledOnce();
  });

  it("publishes transferred copy ownership before fallible preparation bookkeeping", async () => {
    const f = fixture();
    f.copies.prepare.mockImplementation(async input => {
      input.onWarmHandoff?.(f.copy);
      throw new Error("bookkeeping interrupted");
    });
    await expect(f.controller.prepare(f.prepare)).rejects.toThrow("bookkeeping interrupted");
    expect(f.controller.instructionCopy).toBe(f.copy);
    expect(f.reservation.adopt).toHaveBeenCalledWith(f.copy.executionRoot, f.controller.collectStoppedInstructions);
    await f.controller.nativeInstructionReservation?.release();
    expect(f.reservation.release).toHaveBeenCalledOnce();
  });

  it("releases invalidated reuse before fresh preparation and exposes the replacement copy", async () => {
    const f = fixture(), order: string[] = [];
    f.reservation.release.mockImplementation(async () => { order.push("release"); });
    f.copies.prepare.mockImplementationOnce(async () => { order.push("reuse"); throw new AgentDirectoryReuseInvalidatedError("canonical changed"); })
      .mockImplementationOnce(async () => { order.push("fresh"); return f.copy; });
    const config = await f.controller.prepare(f.prepare);
    expect(order).toEqual(["reuse", "release", "fresh"]);
    expect(f.copies.prepare.mock.calls.map(([input]) => input.reuseRunId)).toEqual(["previous-run", undefined]);
    expect(f.controller.nativeInstructionReservation).toBeNull();
    expect(config).toMatchObject({ retained: true, instructionsFilePath: "/workspace/copy/AGENTS.md" });
    expect(f.controller.instructionCopy).toBe(f.copy);
  });

  it("reads the current run row and receipt during stopped collection and warm checkpoints", async () => {
    const f = fixture();
    await f.controller.prepare(f.prepare);
    const running = f.replaceRun();
    await f.controller.collectStoppedInstructions();
    expect(f.appendRunEvent.mock.calls.at(-1)?.[0]).toBe(running);
    expect(f.controller.getInstructionSave()).toMatchObject({ state: "saved" });
    expect(await f.controller.nativeInstructionWorkingCopy()?.checkpointWarm?.()).toBe(true);
    expect(f.controller.getInstructionSave()).toMatchObject({ state: "unchanged" });
    expect(f.appendRunEvent.mock.calls.at(-1)?.[0]).toBe(running);
    expect(f.context.paperclipWorkspace).toMatchObject({ agentHome: f.copy.executionRoot, agentHomeForPermissions: "/canonical" });
  });
});
