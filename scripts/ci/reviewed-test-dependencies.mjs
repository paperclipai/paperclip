import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseSync } from "oxc-parser";

const contracts = new Map([
  ["drizzle-orm/index.js", "96c38000daaf94419eddbfd168f7dc509962d6088664e96882979bf851e0dca5"],
  ["drizzle-orm/pg-core/index.js", "7a6f61b63d19ff5feb4403d8f4afdba90c25364d33769c7a4b3be507c0130357"],
]);

export function dependencyFingerprint(file, packageRoot) {
  const files = new Map();
  function visit(filename) {
    filename = realpathSync(filename);
    if (!filename.startsWith(`${packageRoot}${path.sep}`)) throw new Error("Dependency escapes reviewed package");
    if (files.has(filename)) return;
    const source = readFileSync(filename, "utf8"), ast = parseSync(filename, source);
    if (ast.errors.length) throw new Error("Unparsed dependency");
    const inspect = node => {
      if (!node || typeof node !== "object") return;
      if (node.type === "ImportExpression" || (node.type === "Identifier"
        && /^(require|createRequire|getBuiltinModule|eval|Function)$/.test(node.name))) throw new Error("Unreviewed runtime loader");
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(inspect);
        else if (value && typeof value === "object" && value.type) inspect(value);
      }
    };
    inspect(ast.program);
    files.set(filename, createHash("sha256").update(source).digest("hex"));
    for (const node of ast.program.body) {
      if (!node.source) continue;
      const specifier = node.source.value;
      if (!specifier.startsWith(".")) throw new Error("Unreviewed external import");
      visit(path.resolve(path.dirname(filename), specifier));
    }
  }
  visit(file);
  return createHash("sha256").update(JSON.stringify([...files].map(([file, hash]) =>
    [path.relative(packageRoot, file).split(path.sep).join("/"), hash]).sort())).digest("hex");
}

export function dependencyReviews() {
  const cache = new Map();
  return (file, relative) => {
    if (!contracts.has(relative)) return false;
    if (!cache.has(file)) {
      try {
        const packageRoot = file.slice(0, -relative.slice("drizzle-orm/".length).length - 1);
        cache.set(file, dependencyFingerprint(file, packageRoot) === contracts.get(relative));
      } catch { cache.set(file, false); }
    }
    return cache.get(file);
  };
}
