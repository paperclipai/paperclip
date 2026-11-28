import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertSameOrigin, hostedTarget } from "./hosted-guard.js";
import { isHostedCommand, parseHostedCommand } from "./hosted-config.js";
import { HostedApi, hostedToken } from "./hosted-api.js";

const approved = "release-proof-1.staging.paperclip.app";

describe("hosted target guard", () => {
  it("accepts one explicitly allowed single-stack staging or test host", () => {
    expect(hostedTarget(`https://${approved}`, approved)).toEqual({ baseUrl: `https://${approved}`, host: approved });
    expect(hostedTarget(`https://${approved.toUpperCase()}/`, approved).host).toBe(approved);
    expect(hostedTarget("https://load-check-2.test.paperclip.app", "load-check-2.test.paperclip.app").host)
      .toBe("load-check-2.test.paperclip.app");
  });

  it("refuses a missing URL, a missing or different allow flag, and anything but a bare https origin", () => {
    expect(() => hostedTarget(undefined, approved)).toThrow(/--hosted-base-url/);
    expect(() => hostedTarget(`https://${approved}`, undefined)).toThrow(/--hosted-allow/);
    expect(() => hostedTarget(`https://${approved}`, "other-stack.staging.paperclip.app")).toThrow(/does not match/);
    expect(() => hostedTarget(`http://${approved}`, approved)).toThrow(/https/);
    expect(() => hostedTarget(`https://${approved}/api`, approved)).toThrow(/bare origin/);
    expect(() => hostedTarget(`https://${approved}:8443`, approved)).toThrow(/bare origin/);
    expect(() => hostedTarget(`https://user:pw@${approved}`, approved)).toThrow(/bare origin/);
  });

  it("refuses the shared staging instance even when it is allowed explicitly", () => {
    expect(() => hostedTarget("https://paperclip.staging.paperclip.app", "paperclip.staging.paperclip.app")).toThrow(/shared staging instance/);
  });

  it("refuses production, the fleet admin, Cloud and any host outside staging or test", () => {
    for (const host of ["paperclip.app", "app.paperclip.app", "acme.paperclip.app", "admin-staging.paperclip.app", "my-staging.paperclip.app",
      "admin.staging.paperclip.app", "my.staging.paperclip.app", "a.b.staging.paperclip.app", "evil.staging.paperclip.app.example.com", "localhost", "example.com"]) {
      expect(() => hostedTarget(`https://${host}`, host), host).toThrow(/refused/);
    }
  });

  it("keeps every request on the allowed origin", async () => {
    const target = hostedTarget(`https://${approved}`, approved);
    expect(() => assertSameOrigin(target, "https://paperclip.staging.paperclip.app/api/health")).toThrow(/Refusing/);
    expect(() => assertSameOrigin(target, `https://${approved}/api/health`)).not.toThrow();
    const seen: string[] = [];
    const api = new HostedApi(target, "t", 1_000, (async (url: string) => { seen.push(url); return new Response("{}", { status: 200 }); }) as typeof fetch);
    await api.get("/api/health");
    await expect(api.get("@paperclip.staging.paperclip.app/api/health")).rejects.toThrow(/Refusing/);
    expect(seen).toEqual([`https://${approved}/api/health`]);
  });

  it("takes the board token from the environment or the CLI store for exactly this host, and names what is missing", async () => {
    const target = hostedTarget(`https://${approved}`, approved);
    const dir = await mkdtemp(path.join(os.tmpdir(), "hosted-auth-"));
    const store = path.join(dir, "auth.json");
    await writeFile(store, JSON.stringify({ credentials: { "https://paperclip.staging.paperclip.app": { token: "other" }, [`https://${approved}`]: { token: "mine" } } }));
    expect(hostedToken(target, {}, [path.join(dir, "missing.json"), store])).toBe("mine");
    expect(hostedToken(target, { PAPERCLIP_HOSTED_TOKEN: "env" }, [store])).toBe("env");
    expect(() => hostedToken(hostedTarget("https://other-stack.staging.paperclip.app", "other-stack.staging.paperclip.app"), {}, [store])).toThrow(/No board sign-in/);
    await rm(dir, { recursive: true, force: true });
  });

  it("only enters hosted mode with the hosted flags and refuses a mismatched command", () => {
    expect(isHostedCommand(["--env", "local"])).toBe(false);
    expect(isHostedCommand([`--hosted-base-url=https://${approved}`])).toBe(true);
    expect(() => parseHostedCommand(["--hosted-base-url", "https://paperclip.staging.paperclip.app", "--hosted-allow", "paperclip.staging.paperclip.app"])).toThrow(/refused/);
    expect(() => parseHostedCommand(["--hosted-base-url", `https://${approved}`, "--hosted-allow", approved, "--hosted-cleanup-only"])).toThrow(/--hosted-label/);
    expect(() => parseHostedCommand(["--hosted-base-url", `https://${approved}`, "--hosted-allow", approved, "--hosted-releases", "0"])).toThrow(/--hosted-tasks/);
    const parsed = parseHostedCommand(["--hosted-base-url", `https://${approved}`, "--hosted-allow", approved], new Date("2026-11-12T17:30:00Z"));
    expect(parsed).toMatchObject({ mode: "run", label: "rc-hosted-202611121730", releases: 3, concurrency: 5, ratio: [["opencode", 100]], turnMinutes: [5, 15] });
  });
});
