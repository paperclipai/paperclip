import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerApprovalCommands } from "../commands/client/approval.js";

const APPROVAL_ID = "33333333-3333-4333-8333-333333333333";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerApprovalCommands(program);
  return program;
}

async function runCommand(args: string[]): Promise<void> {
  await createProgram().parseAsync([
    ...args,
    "--api-base", "http://localhost:3100",
    "--api-key", "board-token",
  ], { from: "user" });
}

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}

describe("approval reject command", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses reasonless rejection when neither --reason nor --force is given", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);

    await expect(runCommand(["approval", "reject", APPROVAL_ID])).rejects.toThrow("exit:1");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("Refusing reasonless rejection");
  });

  it("rejects with a reason and persists it as the decision note", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: APPROVAL_ID, status: "rejected" }));
    vi.stubGlobal("fetch", fetchMock);

    await runCommand(["approval", "reject", APPROVAL_ID, "--reason", "Duplicate of an existing hire"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`http://localhost:3100/api/approvals/${APPROVAL_ID}/reject`);
    expect(JSON.parse(String(init.body))).toEqual({ decisionNote: "Duplicate of an existing hire" });
  });

  it("allows the explicit --force path to reject without a reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: APPROVAL_ID, status: "rejected" }));
    vi.stubGlobal("fetch", fetchMock);

    await runCommand(["approval", "reject", APPROVAL_ID, "--force"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`http://localhost:3100/api/approvals/${APPROVAL_ID}/reject`);
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it("still accepts --decision-note for backward compatibility with existing scripts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: APPROVAL_ID, status: "rejected" }));
    vi.stubGlobal("fetch", fetchMock);

    await runCommand(["approval", "reject", APPROVAL_ID, "--decision-note", "Duplicate of an existing hire"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`http://localhost:3100/api/approvals/${APPROVAL_ID}/reject`);
    expect(JSON.parse(String(init.body))).toEqual({ decisionNote: "Duplicate of an existing hire" });
  });

  it("prefers --reason and warns when --reason and --decision-note disagree", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: APPROVAL_ID, status: "rejected" }));
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runCommand([
      "approval",
      "reject",
      APPROVAL_ID,
      "--reason",
      "Reason wins",
      "--decision-note",
      "Different note",
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`http://localhost:3100/api/approvals/${APPROVAL_ID}/reject`);
    expect(JSON.parse(String(init.body))).toEqual({ decisionNote: "Reason wins" });
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("Both --reason and --decision-note");
  });

  it("uses the matching value without warning when --reason and --decision-note agree", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: APPROVAL_ID, status: "rejected" }));
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runCommand([
      "approval",
      "reject",
      APPROVAL_ID,
      "--reason",
      "Same reason",
      "--decision-note",
      "Same reason",
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init.body))).toEqual({ decisionNote: "Same reason" });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("refuses reasonless rejection when neither alias is given even with unrelated flags", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);

    await expect(
      runCommand(["approval", "reject", APPROVAL_ID, "--decided-by-user-id", "user-1"]),
    ).rejects.toThrow("exit:1");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
