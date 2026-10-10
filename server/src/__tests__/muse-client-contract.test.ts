import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

/** Execute the shipped Python client, with synthetic transport responses and private temporary state. */
describe("personal Muse client durability", () => {
  it("preserves identities, private credentials, and input receipts across transport failures", () => {
    execFileSync("python3", [
      fileURLToPath(new URL("./fixtures/muse-client-contract.py", import.meta.url)),
      fileURLToPath(new URL("../services/scripts/muse-client.py", import.meta.url)),
    ], { encoding: "utf8", timeout: 30_000 });
  });
});
