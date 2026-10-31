import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { beforeAll, afterAll, expect, it } from "vitest";
import pins from "./source-sdk-public-inputs.json" with { type: "json" };
import { createSdkArtifactScanner, sdkPublicTypeSyntax } from "./source-sdk-public-type.js";
import { findSecretLeakMatch, normalizedSecrets } from "./redaction.js";
import { diagnosticSecrets } from "./private-diagnostics.js";
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const blob = (v: string | Buffer) => createHash("sha1").update(`blob ${Buffer.byteLength(v)}\0`).update(v).digest("hex");
const originalRoot = path.resolve(import.meta.dirname, "../.."), file = "packages/shared/dist/validators/synthetic-unit.d.ts", inputFile = file.replace("/dist/", "/src/").replace(/\.d\.ts$/, ".ts");
const source = 'import {z} from "zod";export const schema=z.object({daytona_api_key:z.string().min(1)});';
const declaration = 'import {z} from "zod";export declare const schema:{daytona_api_key:z.ZodOptional<z.ZodString>};';
let root: string; let fixtureLockSha256: string;
const fixtureInputs: Record<string, string> = {};
beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "sdk-public-type-synthetic-")));
  for (const [relative] of Object.entries(pins.inputs)) { const dest = path.join(root, relative); await mkdir(path.dirname(dest), { recursive: true }); await copyFile(path.join(originalRoot, relative), dest); fixtureInputs[relative] = blob(await readFile(dest)); }
  await copyFile(path.join(originalRoot, "pnpm-lock.yaml"), path.join(root, "pnpm-lock.yaml")); fixtureLockSha256 = hash(await readFile(path.join(root, "pnpm-lock.yaml")));
  await symlink(await realpath(path.join(originalRoot, "node_modules")), path.join(root, "node_modules"));
  await symlink(await realpath(path.join(originalRoot, "packages/shared/node_modules")), path.join(root, "packages/shared/node_modules"));
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function fixture(sourceText = source) {
  await mkdir(path.dirname(path.join(root, inputFile)), { recursive: true }); await writeFile(path.join(root, inputFile), sourceText);
  return { ...pins, lockSha256: fixtureLockSha256, inputs: { ...fixtureInputs, [inputFile]: blob(sourceText) } };
}
it("classifies varied genuinely public schema types while retaining the raw observation", async () => {
  for (const text of [declaration, declaration.replaceAll("z.", "schemaLibrary.").replace("{z}", "{z as schemaLibrary}"), declaration.replace("ZodString", "ZodNumber")]) {
    const scanner = createSdkArtifactScanner(root, [], await fixture()); expect(await scanner.scan(file, Buffer.from(text))).toBe(true);
    const audit = await scanner.audit(); expect(audit.suppressedFindings).toBe(0); expect(audit.observations).toHaveLength(1); expect(audit.observations[0]!.classification).toBe("public_schema_type");
  }
});
it("protects an exact private value even when equal to a public schema symbol", async () => {
  const scanner = createSdkArtifactScanner(root, ["ZodString"], await fixture()); expect(await scanner.scan(file, Buffer.from(declaration))).toBe(false);
  expect((await scanner.audit()).observations[0]!.classification).toBe("private_exact");
});
it("keeps direct token shapes unconditional inside declarations", async () => {
  const scanner = createSdkArtifactScanner(root, [], await fixture()); expect(await scanner.scan(file, Buffer.from(declaration+'declare const privateValue:"sk-ABCDEFGHIJKLMNOPQRSTUVWX123456789";'))).toBe(false);
  expect((await scanner.audit()).observations.some(row => row.classification === "direct_token")).toBe(true);
});
it.each([
  declaration.replace("z.ZodOptional<z.ZodString>", '"syntheticCredentialValue123456789"'),
  declaration.replace("z.ZodString", '"syntheticCredentialValue123456789"'),
  declaration.replace('from "zod"', 'from "unverified-library"'),
  declaration.replace("z.ZodString", "UnboundPrivateType"),
  declaration.replace("z.ZodString", "typeof privateValue"),
  declaration+'declare namespace z {}',
  declaration.replace("<z.ZodString>", "</* synthetic context */z.ZodString>"),
  'const daytona_api_key="syntheticCredentialValue123456789";',
  '// daytona_api_key: syntheticCredentialValue123456789',
  declaration.slice(0, -2),
])("keeps unknown/literal/initializer/comment/shadow/parse evidence strict", async text => {
  const scanner = createSdkArtifactScanner(root, [], await fixture()); expect(await scanner.scan(file, Buffer.from(text))).toBe(false);
});
it("does not classify unproven files or a forged proof object", async () => {
  const expectations = await fixture(), scanner = createSdkArtifactScanner(root, [], expectations);
  expect(await scanner.scan("arbitrary/credential.d.ts", Buffer.from(declaration))).toBe(false);
  expect(await sdkPublicTypeSyntax({} as never, file, declaration, { start: 0, end: 1 })).toBe(false);
});
it("preserves unknown credential roots/private enum-equal leaves and their encoded values", async () => {
  const raw = JSON.stringify({ unknown: { kind: "identity" }, token: "synthetic-private-value-71983521" });
  const scanner = createSdkArtifactScanner(root, normalizedSecrets([raw]), await fixture());
  for (const text of [declaration+'type PublicKind="identity";', declaration+'type Value="synthetic-private-value-71983521";']) expect(await scanner.scan(file, Buffer.from(text))).toBe(false);
});
it.each(["lockSha256", "compilerPackageSha256", "parserPackageSha256", "parserEntrySha256", "zodPackageSha256", "zodEntrySha256"] as const)("rejects mismatched %s without classifying syntax", async field => {
  const expectations = await fixture(), scanner = createSdkArtifactScanner(root, [], { ...expectations, [field]: "0".repeat(64) });
  expect(await scanner.scan(file, Buffer.from(declaration))).toBe(false); expect((await scanner.audit()).publicSource).toBeNull();
});
it("rejects changed source and unknown source initializers", async () => {
  const expectations = await fixture(); await writeFile(path.join(root, inputFile), source+'\n');
  const scanner = createSdkArtifactScanner(root, [], expectations); expect(await scanner.scan(file, Buffer.from(declaration))).toBe(false);
  const other = createSdkArtifactScanner(root, [], await fixture(source.replace("z.string().min(1)", "privateFactory()"))); expect(await other.scan(file, Buffer.from(declaration))).toBe(false);
});
it("keeps shape overflow blocked with bounded retained observations", async () => {
  const scanner = createSdkArtifactScanner(root, [], await fixture()); expect(await scanner.scan(file, Buffer.from((declaration+'\n').repeat(40)))).toBe(false);
  const audit = await scanner.audit(); expect(audit.bounded).toBe(false); expect(audit.observations).toHaveLength(32);
});

it("requires the authenticated public type export graph", async () => {
  const expected = await fixture();
  const scanner = createSdkArtifactScanner(root, [], { ...expected, zodTypeFiles: { ...expected.zodTypeFiles, "v4/classic/schemas.d.cts": "0".repeat(64) } });
  expect(await scanner.scan(file, Buffer.from(declaration))).toBe(false);
  expect((await scanner.audit()).publicSource).toBeNull();
});
it("rejects non-exported source factories and declaration constructors independently", async () => {
  const unknownFactory = createSdkArtifactScanner(root, [], await fixture(source.replace("z.string()", "z.syntheticUnknownFactory()")));
  expect(await unknownFactory.scan(file, Buffer.from(declaration))).toBe(false);
  const unknownType = createSdkArtifactScanner(root, [], await fixture());
  expect(await unknownType.scan(file, Buffer.from(declaration.replace("ZodString", "syntheticUnknownType")))).toBe(false);
});
it("does not apply typed syntax classification to API, stream, JavaScript or ZIP-shaped content", async () => {
  for (const untyped of ["api-state.json", "persisted-run.ndjson", "entry.js", "blob.zip"]) {
    const scanner = createSdkArtifactScanner(root, [], await fixture());
    expect(await scanner.scan(untyped, Buffer.from(declaration))).toBe(false);
  }
  expect(findSecretLeakMatch(declaration, [])).toBeTruthy();
});
it("keeps raw and encoded credential leaves protected during a synthetic scan roundtrip", async () => {
  const roots = diagnosticSecrets([JSON.stringify({ private: { kind: "identity", value: "synthetic-private-value-71983521" } })]).values;
  for (const value of ["identity", "synthetic-private-value-71983521", Buffer.from("synthetic-private-value-71983521").toString("base64"), encodeURIComponent("synthetic-private-value-71983521")]) {
    const scanner = createSdkArtifactScanner(root, roots, await fixture());
    const bytes = Buffer.from(declaration+'type SyntheticPrivateValue="'+value+'";');
    expect(await scanner.scan(file, bytes)).toBe(false);
  }
});
