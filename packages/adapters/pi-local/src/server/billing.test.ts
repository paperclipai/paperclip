import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPiAuthCredentialKinds, resolvePiBiller, resolvePiBillingType } from "./billing.js";

const tempHomes: string[] = [];

async function makeHomeWithAuthFile(contents: string | null): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pi-billing-"));
  tempHomes.push(home);
  if (contents !== null) {
    const agentDir = path.join(home, ".pi", "agent");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "auth.json"), contents, "utf-8");
  }
  return home;
}

afterEach(async () => {
  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) await fs.rm(home, { recursive: true, force: true });
  }
});

describe("resolvePiBillingType", () => {
  it("prices GitHub Copilot as metered credits, not an included subscription", () => {
    // The seat is a subscription, but agent traffic on it is metered against
    // premium credits and invoiced as overage. `subscription` would be zeroed by
    // the server's normalizeBilledCostCents and report that lane as free.
    expect(resolvePiBillingType({}, "github-copilot")).toBe("credits");
    expect(resolvePiBillingType({ OPENAI_API_KEY: "sk-test" }, "github-copilot")).toBe("credits");
  });

  it("treats API-key-only providers as metered even when the key lives in auth.json", () => {
    expect(resolvePiBillingType({}, "google")).toBe("api");
    expect(resolvePiBillingType({ GEMINI_API_KEY: "test" }, "google")).toBe("api");
    expect(resolvePiBillingType({}, "groq")).toBe("api");
  });

  it("splits dual-auth providers on the presence of an API key in the environment", () => {
    expect(resolvePiBillingType({ ANTHROPIC_API_KEY: "sk-ant-test" }, "anthropic")).toBe("api");
    expect(resolvePiBillingType({ OPENAI_API_KEY: "sk-test" }, "openai")).toBe("api");
    expect(resolvePiBillingType({ XAI_API_KEY: "test" }, "xai")).toBe("api");
    expect(resolvePiBillingType({ ANTHROPIC_API_KEY: "   " }, "anthropic")).toBe("unknown");
  });

  it("uses the stored auth.json credential kind when the environment has no key", () => {
    expect(resolvePiBillingType({}, "anthropic", { anthropic: "oauth" })).toBe("subscription");
    expect(resolvePiBillingType({}, "anthropic", { anthropic: "api_key" })).toBe("api");
    expect(resolvePiBillingType({}, "openai", { openai: "api_key" })).toBe("api");
  });

  it("stays unknown for a dual-auth provider whose credential it cannot see", () => {
    // Remote execution target, or a key pi picked up some other way. Guessing
    // `subscription` here would zero a real metered bill.
    expect(resolvePiBillingType({}, "anthropic")).toBe("unknown");
    expect(resolvePiBillingType({}, "openai", { anthropic: "oauth" })).toBe("unknown");
  });

  it("reports OpenRouter as prepaid credits regardless of how the key was minted", () => {
    expect(resolvePiBillingType({}, "openrouter")).toBe("credits");
    expect(resolvePiBillingType({ OPENROUTER_API_KEY: "sk-or-test" }, "openrouter")).toBe("credits");
  });

  it("normalizes provider casing and whitespace", () => {
    expect(resolvePiBillingType({}, "  GitHub-Copilot  ")).toBe("credits");
    expect(resolvePiBillingType({}, "  Anthropic  ", { anthropic: "oauth" })).toBe("subscription");
  });

  it("stays unknown for missing or custom providers instead of guessing", () => {
    expect(resolvePiBillingType({}, null)).toBe("unknown");
    expect(resolvePiBillingType({}, "   ")).toBe("unknown");
    expect(resolvePiBillingType({}, "my-self-hosted-gateway")).toBe("unknown");
  });
});

describe("readPiAuthCredentialKinds", () => {
  it("reads the credential kind per provider without returning secret material", async () => {
    const home = await makeHomeWithAuthFile(
      JSON.stringify({
        "github-copilot": { type: "oauth", access: "secret", refresh: "secret", expires: 1 },
        anthropic: { type: "oauth", access: "secret" },
        google: { type: "api_key", key: "secret" },
      }),
    );
    const kinds = await readPiAuthCredentialKinds(home);
    expect(kinds).toEqual({ "github-copilot": "oauth", anthropic: "oauth", google: "api_key" });
    expect(JSON.stringify(kinds)).not.toContain("secret");
  });

  it("ignores entries with an unrecognized or missing type", async () => {
    const home = await makeHomeWithAuthFile(
      JSON.stringify({ anthropic: { type: "device_code" }, openai: {}, xai: "nope" }),
    );
    await expect(readPiAuthCredentialKinds(home)).resolves.toEqual({});
  });

  it("returns an empty map when the auth file is missing or malformed", async () => {
    const missing = await makeHomeWithAuthFile(null);
    await expect(readPiAuthCredentialKinds(missing)).resolves.toEqual({});
    const malformed = await makeHomeWithAuthFile("{not json");
    await expect(readPiAuthCredentialKinds(malformed)).resolves.toEqual({});
    const notAnObject = await makeHomeWithAuthFile("[]");
    await expect(readPiAuthCredentialKinds(notAnObject)).resolves.toEqual({});
  });
});

describe("resolvePiBiller", () => {
  it("prefers an OpenAI-compatible biller inferred from the environment", () => {
    expect(resolvePiBiller({ OPENROUTER_API_KEY: "sk-or-test" }, "openai")).toBe("openrouter");
  });

  it("falls back to the provider parsed from the model id", () => {
    expect(resolvePiBiller({}, "github-copilot")).toBe("github-copilot");
  });

  it("falls back to unknown when there is no provider at all", () => {
    expect(resolvePiBiller({}, null)).toBe("unknown");
  });
});
