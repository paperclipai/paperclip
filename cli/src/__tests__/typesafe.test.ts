import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTypesafeCommands } from "../commands/client/typesafe.js";

const COMPANY = "5b0e9d0c-3c1b-4a53-9d0e-6a1f6f0f6a11";
const RUN = "0c2f3f1e-6a0b-4f7e-9f7c-1d8a54b7a001";
const REQUEST = {
  state: "Help! My payouts have been failing for 3 days.",
  questions: { urgent: { type: "noul", instructions: "Urgent?" } },
};
const ANSWER = {
  model: "jev-1.13.0",
  answers: { urgent: { type: "noul", noul: 0.95 } },
  usage: { input_tokens: 10, output_tokens: 2 },
};

describe("paperclipai typesafe ask", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-typesafe-cli-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  async function run(file: string) {
    const program = new Command().exitOverride();
    registerTypesafeCommands(program);
    await program.parseAsync(
      [
        "typesafe", "ask", "--file", file,
        "--api-base", "http://paperclip.test", "--api-key", "agent-key",
        "--company-id", COMPANY, "--run-id", RUN, "--data-dir", dir, "--json",
      ],
      { from: "user" },
    );
  }

  it("posts the request file with the run id and prints the answer", async () => {
    const file = path.join(dir, "request.json");
    await writeFile(file, JSON.stringify(REQUEST));
    const fetcher = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(JSON.stringify(ANSWER), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await run(file);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`http://paperclip.test/api/companies/${COMPANY}/typesafe/ask`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(REQUEST);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer agent-key");
    expect(headers.get("x-paperclip-run-id")).toBe(RUN);
    expect(JSON.parse(log.mock.calls.map((call) => call.join(" ")).join("\n"))).toEqual(ANSWER);
  });

  it("rejects a malformed request file before calling the API", async () => {
    const file = path.join(dir, "bad.json");
    await writeFile(
      file,
      JSON.stringify({ state: "s", questions: { q: { type: "score", instructions: "?", criteria: ["only"] } } }),
    );
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(run(file)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
