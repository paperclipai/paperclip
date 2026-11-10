import defaultInputs from "./source-sdk-public-inputs.json" with { type: "json" };
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { findSecretLeakMatch, secretShapeObservations } from "./redaction.js";

const hash = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
export interface SdkPublicInputs {
  inputs: Record<string, string>; lockSha256: string; compilerPackageSha256: string;
  parserPackageSha256: string; parserEntrySha256: string; zodPackageSha256: string; zodEntrySha256: string; zodTypeFiles: Record<string, string>;
}
interface PublicSource {
  root: string; parser: { parse(text: string, options: unknown): any }; constructors: Record<string, unknown>; factories: Record<string, unknown>;
  inputs: SdkPublicInputs; identity: { inputs: number; manifestSha256: string; lockSha256: string; compilerPackageSha256: string; parserPackageSha256: string; parserEntrySha256: string; zodPackageSha256: string; zodEntrySha256: string; zodTypeGraphSha256: string };
}
const verified = new WeakSet<PublicSource>();
export async function verifySdkPublicSource(root: string, expectations?: SdkPublicInputs): Promise<PublicSource> {
  const supplied = expectations ?? defaultInputs;
  const inputs: SdkPublicInputs = Object.freeze({ ...supplied, inputs: Object.freeze({ ...supplied.inputs }), zodTypeFiles: Object.freeze({ ...supplied.zodTypeFiles }) });
  if (await realpath(root) !== root) throw new Error("SDK public source proof unavailable");
  for (const [file, expected] of Object.entries(inputs.inputs)) {
    if (!/^[A-Za-z0-9._/-]+$/.test(file) || file.split("/").includes("..")) throw new Error("SDK public source proof unavailable");
    const filename = path.join(root, file), stat = await lstat(filename);
    const bytes = await readFile(filename);
    // The authenticated restored lock is the sole overlay on frozen Git inputs.
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(filename) !== filename
      || (file === "pnpm-lock.yaml" ? hash(bytes) !== inputs.lockSha256 : createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== expected)) throw new Error("SDK public source proof unavailable");
  }
  const actualSources: string[] = [];
  const collect = async (directory: string) => {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await collect(file);
      else if (entry.isFile()) actualSources.push(file);
      else throw new Error("SDK public source proof unavailable");
    }
  };
  for (const directory of ["packages/shared/src", "packages/plugins/sdk/src"]) await collect(directory);
  const expectedSources = Object.keys(inputs.inputs).filter(file => file.startsWith("packages/shared/src/") || file.startsWith("packages/plugins/sdk/src/"));
  if (JSON.stringify(actualSources.sort()) !== JSON.stringify(expectedSources.sort())) throw new Error("SDK public source proof unavailable");
  const matches = async (file: string, expected: string) => { if (hash(await readFile(file)) !== expected) throw new Error("SDK public source proof unavailable"); };
  await matches(path.join(root, "pnpm-lock.yaml"), inputs.lockSha256);
  await matches(path.join(root, "node_modules/typescript/package.json"), inputs.compilerPackageSha256);
  const parserRoot = path.join(root, "node_modules/.pnpm/@babel+parser@7.29.8/node_modules/@babel/parser");
  await matches(path.join(parserRoot, "package.json"), inputs.parserPackageSha256); await matches(path.join(parserRoot, "lib/index.js"), inputs.parserEntrySha256);
  const require = createRequire(path.join(root, "packages/shared/package.json")), zodPackage = require.resolve("zod/package.json"), zodEntry = require.resolve("zod");
  await matches(zodPackage, inputs.zodPackageSha256); await matches(zodEntry, inputs.zodEntrySha256);
  const parser = createRequire(path.join(parserRoot, "package.json"))("./lib/index.js");
  const publicTypes = new Map<string, any>();
  for (const [relative, expected] of Object.entries(inputs.zodTypeFiles)) {
    if (!/^[A-Za-z0-9._/-]+$/.test(relative) || relative.split("/").includes("..")) throw new Error("SDK public source proof unavailable");
    const file = path.join(path.dirname(zodPackage), relative); await matches(file, expected);
    const ast = parser.parse(await readFile(file, "utf8"), { sourceType: "module", plugins: [["typescript", { dts: true }]], errorRecovery: true });
    if (ast.errors.length) throw new Error("SDK public source proof unavailable"); publicTypes.set(relative, ast);
  }
  const resolves = (parent: string, specifier: unknown, child: string) => typeof specifier === "string" && path.posix.normalize(path.posix.join(path.posix.dirname(parent), specifier)).replace(/\.(?:cjs|js)$/, ".d.cts") === child;
  const entry = publicTypes.get("index.d.cts"), external = publicTypes.get("v4/classic/external.d.cts"), schemas = publicTypes.get("v4/classic/schemas.d.cts");
  if (!entry || !external || !schemas || !entry.program.body.some((n: any) => n.type === "ExportAllDeclaration" && resolves("index.d.cts", n.source?.value, "v4/classic/external.d.cts"))
    || !external.program.body.some((n: any) => n.type === "ExportAllDeclaration" && resolves("v4/classic/external.d.cts", n.source?.value, "v4/classic/schemas.d.cts"))) throw new Error("SDK public source proof unavailable");
  const namespaces = entry.program.body.filter((n: any) => n.type === "ImportDeclaration" && resolves("index.d.cts", n.source?.value, "v4/classic/external.d.cts")).flatMap((n: any) => n.specifiers.filter((s: any) => s.type === "ImportNamespaceSpecifier").map((s: any) => s.local.name));
  if (!entry.program.body.some((n: any) => n.type === "ExportNamedDeclaration" && n.specifiers?.some((s: any) => s.exported?.name === "z" && namespaces.includes(s.local?.name)))) throw new Error("SDK public source proof unavailable");
  const declaredTypes = new Set(schemas.program.body.filter((n: any) => n.type === "ExportNamedDeclaration" && ["TSInterfaceDeclaration", "TSTypeAliasDeclaration", "ClassDeclaration"].includes(n.declaration?.type)).map((n: any) => n.declaration.id.name));
  const declaredFactories = new Set(schemas.program.body.filter((n: any) => n.type === "ExportNamedDeclaration" && ["TSDeclareFunction", "FunctionDeclaration"].includes(n.declaration?.type)).map((n: any) => n.declaration.id.name));
  const zod = require("zod"), namespace = zod.z ?? zod;
  const constructors = Object.freeze(Object.fromEntries(Object.entries(namespace).filter(([name, value]) => declaredTypes.has(name) && typeof value === "function")));
  const factories = Object.freeze(Object.fromEntries(Object.entries(namespace).filter(([name, value]) => declaredFactories.has(name) && typeof value === "function")));
  const source = { root, parser, constructors, factories, inputs, identity: { inputs: Object.keys(inputs.inputs).length, manifestSha256: hash(JSON.stringify(inputs)),
    lockSha256: inputs.lockSha256, compilerPackageSha256: inputs.compilerPackageSha256, parserPackageSha256: inputs.parserPackageSha256,
    parserEntrySha256: inputs.parserEntrySha256, zodPackageSha256: inputs.zodPackageSha256, zodEntrySha256: inputs.zodEntrySha256, zodTypeGraphSha256: hash(JSON.stringify(inputs.zodTypeFiles)) } };
  Object.freeze(source.identity); Object.freeze(source); verified.add(source); return source;
}
function nodes(node: any, fn: (node: any) => void) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const child of node) nodes(child, fn); return; }
  if (typeof node.type !== "string") return;
  fn(node);
  for (const [key, value] of Object.entries(node)) if (!["loc", "extra", "errors", "tokens", "comments", "leadingComments", "trailingComments", "innerComments"].includes(key)) nodes(value, fn);
}
function aliases(ast: any): string[] {
  const found: string[] = [];
  for (const row of ast.program.body) if (row.type === "ImportDeclaration" && row.source.value === "zod") {
    for (const s of row.specifiers) if (s.type === "ImportNamespaceSpecifier" || s.type === "ImportSpecifier" && s.imported.name === "z") found.push(s.local.name);
  }
  if (new Set(found).size !== found.length) return [];
  let shadowed = false;
  nodes(ast, n => {
    if (n.type === "TSModuleDeclaration") shadowed = true;
    if (["VariableDeclarator", "FunctionDeclaration", "ClassDeclaration", "TSModuleDeclaration", "TSTypeAliasDeclaration", "TSInterfaceDeclaration", "TSEnumDeclaration"].includes(n.type) && found.includes(n.id?.name)) shadowed = true;
    if (n.type === "TSTypeParameter" && found.includes(typeof n.name === "string" ? n.name : n.name?.name)) shadowed = true;
    if (Array.isArray(n.params) && n.params.some((p: any) => p.type === "Identifier" && found.includes(p.name))) shadowed = true;
  });
  return shadowed ? [] : found;
}
function parsed(source: PublicSource, text: string, declaration: boolean) {
  const ast = source.parser.parse(text, { sourceType: "module", plugins: [["typescript", { dts: declaration }]], errorRecovery: true });
  if (ast.errors.length) throw new Error("SDK public source parse unavailable"); return ast;
}
const primitive = (node: any) => node?.type === "NumericLiteral" && Number.isFinite(node.value) || ["BooleanLiteral", "NullLiteral"].includes(node?.type) || node?.type === "StringLiteral" && node.value === "";
function publicSourceProperty(source: PublicSource, ast: any, key: string) {
  const publicAliases = aliases(ast), properties: any[] = [];
  nodes(ast, n => { if (n.type === "ObjectProperty" && !n.computed && (n.key?.name ?? n.key?.value) === key) properties.push(n); });
  if (properties.length !== 1) return false;
  let value = properties[0].value, factory: string | undefined;
  while (value?.type === "CallExpression" && value.callee?.type === "MemberExpression" && !value.callee.computed && value.callee.property?.type === "Identifier") {
    if (!value.arguments.every(primitive)) return false;
    factory = value.callee.property.name; value = value.callee.object;
  }
  return value?.type === "Identifier" && publicAliases.includes(value.name) && !!factory && Object.hasOwn(source.factories, factory) && typeof source.factories[factory] === "function";
}
export async function sdkPublicTypeSyntax(source: PublicSource, file: string, text: string, span: { start: number; end: number }) {
  if (!verified.has(source) || Buffer.byteLength(text) > 8 * 1024 * 1024) return false;
  const original = file.replace("/dist/", "/src/").replace(/\.d\.ts$/, ".ts");
  if (original === file || !source.inputs.inputs[original]) return false;
  const filename = path.join(source.root, original), sourceText = await readFile(filename, "utf8");
  if (createHash("sha1").update(`blob ${Buffer.byteLength(sourceText)}\0`).update(sourceText).digest("hex") !== source.inputs.inputs[original]) return false;
  try {
    const ast = parsed(source, text, true), publicAliases = aliases(ast), candidates: any[] = [];
    nodes(ast, n => { if (n.type === "TSPropertySignature" && n.start <= span.start && n.end >= span.end) candidates.push(n); });
    candidates.sort((a, b) => (a.end - a.start) - (b.end - b.start)); const property = candidates[0], type = property?.typeAnnotation?.typeAnnotation;
    if (!property || property.computed || property.key?.type !== "Identifier" || property.initializer || property.value || type?.type !== "TSTypeReference"
      || span.start < property.key.start || span.start >= property.key.end || type.typeName?.type !== "TSQualifiedName" || span.end !== type.typeName.end
      || !/^\s*:\s*$/.test(text.slice(property.key.end, type.typeName.start))
      || (ast.comments ?? []).some((c: any) => c.start < property.end && c.end > property.start)) return false;
    let bound = true, references = 0;
    nodes(property.typeAnnotation, n => {
      if (!["TSTypeAnnotation", "TSTypeReference", "TSQualifiedName", "TSTypeParameterInstantiation", "Identifier"].includes(n.type)) bound = false;
      if (n.type === "TSTypeReference") {
        references++; const name = n.typeName;
        if (name?.type !== "TSQualifiedName" || name.left?.type !== "Identifier" || name.right?.type !== "Identifier" || !publicAliases.includes(name.left.name)
          || !Object.hasOwn(source.constructors, name.right.name) || typeof source.constructors[name.right.name] !== "function") bound = false;
      }
    });
    return bound && references > 0 && publicSourceProperty(source, parsed(source, sourceText, false), property.key.name);
  } catch { return false; }
}
export interface SdkScanObservation { pathSha256: string; fileSha256: string; detector: number; start: number; end: number; classification: "private_exact" | "direct_token" | "unresolved_context" | "public_schema_type" }
export function createSdkArtifactScanner(repositoryRoot: string, secrets: readonly string[], expectations?: SdkPublicInputs) {
  const observations: SdkScanObservation[] = []; let bounded = true; let proof: Promise<PublicSource | null> | undefined;
  const source = () => proof ??= verifySdkPublicSource(repositoryRoot, expectations).catch(() => null);
  return {
    async scan(file: string, bytes: Buffer) {
      const base = { pathSha256: hash(file), fileSha256: hash(bytes) };
      if (findSecretLeakMatch(bytes, secrets, { includeShapes: false })) { observations.push({ ...base, detector: -1, start: 0, end: bytes.length, classification: "private_exact" }); return false; }
      const raw = secretShapeObservations(bytes.toString("utf8")); if (!raw.bounded) { bounded = false; for (const span of raw.matches) observations.push({ ...base, ...span, classification: span.detector === 3 ? "unresolved_context" : "direct_token" }); return false; }
      if (raw.matches.some(span => span.detector !== 3)) {
        for (const span of raw.matches) observations.push({ ...base, ...span, classification: span.detector === 3 ? "unresolved_context" : "direct_token" });
        return false;
      }
      let safe = true;
      for (const span of raw.matches) {
        const publicSource = span.detector === 3 ? await source() : null;
        const syntax = !!publicSource && await sdkPublicTypeSyntax(publicSource, file, bytes.toString("utf8"), span);
        const classification = span.detector !== 3 ? "direct_token" : syntax ? "public_schema_type" : "unresolved_context";
        observations.push({ ...base, ...span, classification }); if (!syntax) safe = false;
      }
      return safe;
    },
    async audit() { const p = proof ? await proof : null; return { schema: "paperclip.source-sdk-scan/v1", suppressedFindings: 0, bounded, publicSource: p?.identity ?? null, observations: structuredClone(observations).sort((a, b) => a.pathSha256.localeCompare(b.pathSha256) || a.detector - b.detector || a.start - b.start) }; },
  };
}
