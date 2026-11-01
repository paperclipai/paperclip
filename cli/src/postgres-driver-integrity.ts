import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PATCHED_POSTGRES_DRIVER = {
  version: "3.4.9",
  files: {
    "src/connection.js": "b57261592f135d127b8e7267c78981eb2c5f4751259641b782ba621b89d939d1",
    "src/index.js": "07dee80154d83ca9163a4a8790ef0281602ffca682e2387b3487bf20395d2adf",
    "cjs/src/connection.js": "c3e6807f967203cd35eeb7632f01b419d7ed2405f657f9f5654729c3422bd98a",
    "cjs/src/index.js": "b28d16e69f28dc5d5ba9a944329f191d896f7ab80ac49300445da7ba8c594d22",
  },
} as const;

export const POSTGRES_DRIVER_CALLERS = ["paperclipai", "@paperclipai/db"] as const;

export type PostgresDriverResolution = { caller: string; import: string; require: string; packageRoot: string };

const RESOLVE_SCRIPT = [
  "import { createRequire } from 'node:module';",
  "const require = createRequire(import.meta.url);",
  "process.stdout.write(JSON.stringify({ import: import.meta.resolve('postgres'), require: require.resolve('postgres') }));",
].join("\n");

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function assertPatchedDriver(packageRoot: string, label: string): void {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { name?: string; version?: string };
  if (manifest.name !== "postgres" || manifest.version !== PATCHED_POSTGRES_DRIVER.version) {
    throw new Error(`${label} is ${manifest.name ?? "unknown"}@${manifest.version ?? "unknown"}; expected patched postgres@${PATCHED_POSTGRES_DRIVER.version}.`);
  }
  for (const [file, expected] of Object.entries(PATCHED_POSTGRES_DRIVER.files)) {
    const location = path.join(packageRoot, file);
    const actual = fs.existsSync(location) ? sha256(location) : "missing";
    if (actual !== expected) throw new Error(`${label} ${file} is ${actual}; expected patched ${expected}.`);
  }
}

type PackageInventory = { name: string; directory: string }[];

function inventoryPackages(nodeModules: string, inventory: PackageInventory = [], depth = 0): PackageInventory {
  if (depth > 32 || !fs.existsSync(nodeModules)) return inventory;
  for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
    const directory = path.join(nodeModules, entry.name);
    const packages = entry.name.startsWith("@")
      ? fs.readdirSync(directory, { withFileTypes: true }).filter((child) => child.isDirectory()).map((child) => path.join(directory, child.name))
      : [directory];
    for (const packageDirectory of packages) {
      inventory.push({ name: path.relative(nodeModules, packageDirectory), directory: packageDirectory });
      inventoryPackages(path.join(packageDirectory, "node_modules"), inventory, depth + 1);
    }
  }
  return inventory;
}

function findForbiddenLinks(payloadRoot: string): string[] {
  const forbidden: string[] = [];
  const pending = [payloadRoot];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(location);
      else if (entry.isSymbolicLink()) {
        const binLink = path.basename(directory) === ".bin" && path.basename(path.dirname(directory)) === "node_modules";
        const target = fs.existsSync(location) ? fs.realpathSync(location) : null;
        if (!binLink || !target || !inside(payloadRoot, target) || fs.statSync(location).isDirectory()) forbidden.push(location);
      }
    }
  }
  return forbidden;
}

const copiesOf = (inventory: PackageInventory, name: string) =>
  inventory.filter((entry) => entry.name === name).map((entry) => entry.directory);

export async function verifyPostgresDriverPayload(payloadPath: string): Promise<PostgresDriverResolution[]> {
  const payloadRoot = fs.realpathSync(payloadPath);
  const nodeModules = path.join(payloadRoot, "node_modules");
  const links = findForbiddenLinks(payloadRoot);
  if (links.length > 0) {
    throw new Error(`Payload must not contain linked files or packages; found ${links.slice(0, 10).map((link) => path.relative(payloadRoot, link)).join(", ")}.`);
  }
  const inventory = inventoryPackages(nodeModules);
  const copies = copiesOf(inventory, "postgres");
  if (copies.length === 0) throw new Error(`Payload ${payloadPath} contains no postgres driver.`);
  const rootCopy = path.join(nodeModules, "postgres");
  const extra = copies.filter((copy) => copy !== rootCopy);
  if (extra.length > 0 || !copies.includes(rootCopy)) {
    throw new Error(`Payload must contain exactly one postgres driver at node_modules/postgres; found ${copies.map((copy) => path.relative(payloadRoot, copy)).join(", ")}.`);
  }
  assertPatchedDriver(rootCopy, "Payload driver node_modules/postgres");
  const callers: { caller: string; directory: string }[] = POSTGRES_DRIVER_CALLERS.map((caller) => ({ caller, directory: path.join(nodeModules, caller) }));
  for (const caller of callers) {
    if (!fs.existsSync(path.join(caller.directory, "package.json"))) throw new Error(`Payload is missing postgres caller ${caller.caller}.`);
  }
  const drizzleDrivers = copiesOf(inventory, "drizzle-orm")
    .map((copy) => path.join(copy, "postgres-js"))
    .filter((directory) => fs.existsSync(path.join(directory, "driver.js")));
  if (drizzleDrivers.length === 0) throw new Error(`Payload ${payloadPath} contains no drizzle-orm postgres-js driver.`);
  for (const directory of drizzleDrivers) callers.push({ caller: path.relative(payloadRoot, path.join(directory, "driver.js")), directory });
  const env = { ...process.env };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  const expectedRoot = fs.realpathSync(rootCopy);
  const resolutions: PostgresDriverResolution[] = [];
  for (const { caller, directory } of callers) {
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", RESOLVE_SCRIPT], { cwd: directory, env, encoding: "utf8", timeout: 30_000 });
    const resolved = JSON.parse(stdout) as { import: string; require: string };
    const importPath = fs.realpathSync(new URL(resolved.import));
    const requirePath = fs.realpathSync(resolved.require);
    if (!inside(payloadRoot, importPath) || !inside(payloadRoot, requirePath)) {
      throw new Error(`${caller} resolves postgres outside the payload: ${importPath}, ${requirePath}.`);
    }
    if (importPath !== path.join(expectedRoot, "src", "index.js") || requirePath !== path.join(expectedRoot, "cjs", "src", "index.js")) {
      throw new Error(`${caller} does not resolve the payload's patched postgres driver ESM and CommonJS entrypoints: ${importPath}, ${requirePath}.`);
    }
    resolutions.push({ caller, import: importPath, require: requirePath, packageRoot: expectedRoot });
  }
  return resolutions;
}
