import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudflareSandboxProvider } from "@paperclipai/sandbox-provider-cloudflare";

describe("cloudflare sandbox provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps namespace on all instance requests and emulates stdin via a temp file", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });

        if (url === "https://gateway.example/v1/sandboxes") {
          return new Response(JSON.stringify({ sandboxId: "sandbox-1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (url.startsWith("https://gateway.example/v1/sandboxes/sandbox-1/files?")) {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (url.startsWith("https://gateway.example/v1/sandboxes/sandbox-1/exec?")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          const command = String(body.command ?? "");
          if (command.startsWith("rm -f ")) {
            return new Response(JSON.stringify({ exitCode: 0, signal: null, timedOut: false }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(
            [
              JSON.stringify({ type: "stdout", chunk: "hello\n" }),
              JSON.stringify({ type: "exit", exitCode: 0, signal: null, timedOut: false }),
            ].join("\n"),
            {
              status: 200,
              headers: { "content-type": "application/x-ndjson" },
            },
          );
        }

        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const provider = createCloudflareSandboxProvider({
      providerConfig: {
        baseUrl: "https://gateway.example",
        namespace: "team-a",
      },
    });

    const instance = await provider.create({ sandboxId: "sandbox-1" });
    const stdout: string[] = [];
    const result = await instance.exec("'codex' 'exec' '-'", {
      stdin: "prompt body",
      onStdout: (chunk) => {
        stdout.push(chunk);
      },
    });

    expect(result).toEqual({ exitCode: 0, signal: null, timedOut: false });
    expect(stdout).toEqual(["hello\n"]);
    expect(calls).toHaveLength(4);
    expect(calls[0]?.url).toBe("https://gateway.example/v1/sandboxes");
    expect(JSON.parse(String(calls[0]?.init?.body ?? "{}"))).toMatchObject({
      sandboxId: "sandbox-1",
      namespace: "team-a",
    });
    expect(calls[1]?.url).toContain("/v1/sandboxes/sandbox-1/files?namespace=team-a");
    expect(JSON.parse(String(calls[1]?.init?.body ?? "{}"))).toMatchObject({
      content: "prompt body",
    });
    expect(calls[2]?.url).toContain("/v1/sandboxes/sandbox-1/exec?namespace=team-a");
    expect(JSON.parse(String(calls[2]?.init?.body ?? "{}")).command).toContain("paperclip-stdin-");
    expect(calls[3]?.url).toContain("/v1/sandboxes/sandbox-1/exec?namespace=team-a");
  });
});
