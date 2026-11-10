import { readFile, stat } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { projectDefaultsCases } from "./internal-project-defaults.js";

vi.mock("./internal-definition.js", async original => ({
  ...await original<typeof import("./internal-definition.js")>(),
  fixtureWorker: async () => ({ id: "10000000-0000-4000-8000-000000000001" }),
}));
vi.mock("../api.js", async original => ({
  ...await original<typeof import("../api.js")>(),
  pollUntil: async () => { throw new Error("controlled checkout failure"); },
}));

it.each(["creation", "checkout"])("cleans the private prerequisite after %s fails before setup returns state", async phase => {
  let scriptPath = "", url = "";
  const context = {
    observationDeadlineAt: Date.now() + 120_000,
    input: {
      privateSecrets: [], fixtures: { company: { id: "company" }, agent: { id: "lead" } },
      api: {
        patch: async () => ({}),
        post: async (_path: string, body: Record<string, unknown>) => {
          if (body.title === "Active launch research") {
            scriptPath = String(body.description).match(/'([^']*read-brief\.mjs)'/)![1]!;
            const script = await readFile(scriptPath, "utf8");
            url = JSON.parse(script.match(/get\(("[^"]+")/)![1]!);
            if (phase === "creation") throw new Error("controlled creation failure");
          }
          return { ...body, id: "created-resource" };
        },
      },
    },
  } as unknown as ChatCatalogContext;
  const definition = projectDefaultsCases[0]!;
  try {
    await expect(definition.setup(context)).rejects.toThrow(`controlled ${phase} failure`);
    expect(scriptPath).not.toBe("");
    await expect(stat(scriptPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  } finally {
    // Also close the old implementation after its regression assertion fails.
    await definition.cleanup?.(context, {});
  }
});
