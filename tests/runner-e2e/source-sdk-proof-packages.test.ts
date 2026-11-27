import { realpath } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import pins from "./source-sdk-public-inputs.json" with { type: "json" };
import { verifySdkProofPackages } from "./source-sdk-public-type.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

it("installed TypeScript, parser and Zod packages match the reviewed SDK proof pins", async () => {
  await expect(verifySdkProofPackages(await realpath(repositoryRoot))).resolves.toBeTruthy();
});

it("rejects an installed proof package that differs from its pin", async () => {
  await expect(verifySdkProofPackages(await realpath(repositoryRoot), { ...pins, zodPackageSha256: "0".repeat(64) }))
    .rejects.toThrow("SDK public source proof unavailable");
});
