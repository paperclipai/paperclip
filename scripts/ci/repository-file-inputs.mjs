import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const filesystem = /^(?:node:)?fs(?:\/promises)?$/;
const readers = new Set(["readFile", "readFileSync", "existsSync", "stat", "statSync", "lstat", "lstatSync", "readdir", "readdirSync"]);

export function repositoryFileInputs(file, program) {
  if (!program.body.some(node => node.type === "ImportDeclaration" && filesystem.test(node.source.value))) {
    return { covered: [], inputs: [] };
  }
  const parents = new Map(), nodes = [], declarations = new Map(), constants = new Map(), imports = new Map();
  const bind = (node) => {
    if (!node) return;
    if (node.type === "Identifier") declarations.set(node.name, (declarations.get(node.name) ?? 0) + 1);
    else if (node.type === "ObjectPattern") node.properties.forEach(p => bind(p.value ?? p.argument));
    else if (node.type === "ArrayPattern") node.elements.forEach(bind);
    else if (node.type === "AssignmentPattern") bind(node.left);
    else if (node.type === "RestElement") bind(node.argument);
  };
  function visit(node, parent) {
    if (!node || typeof node !== "object" || !node.type) return;
    parents.set(node, parent); nodes.push(node);
    if (node.type === "ImportDeclaration") {
      for (const spec of node.specifiers) {
        bind(spec.local);
        const source = filesystem.test(node.source.value) ? node.source.value.replace(/^node:/, "") : node.source.value;
        imports.set(spec.local.name, { source, name: spec.type === "ImportSpecifier" ? spec.imported.name : "*" });
      }
    }
    if (node.type === "VariableDeclarator") {
      bind(node.id);
      if (parent.kind === "const" && node.id.type === "Identifier") constants.set(node.id.name, node.init);
    }
    if (/Function/.test(node.type) || node.type === "ArrowFunctionExpression") {
      bind(node.id); node.params?.forEach(bind);
    }
    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") bind(node.id);
    if (node.type === "CatchClause") bind(node.param);
    if (node.type === "AssignmentExpression") bind(node.left);
    if (node.type === "UpdateExpression") bind(node.argument);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, node));
      else if (value && typeof value === "object" && value.type) visit(value, node);
    }
  }
  visit(program);
  const tainted = new Set();
  for (const node of nodes) {
    if (node.type === "MetaProperty" && node.meta.name === "import" && node.property.name === "meta") {
      const member = parents.get(node), use = parents.get(member);
      if (member?.type !== "MemberExpression" || member.computed || !["url", "dirname", "filename"].includes(member.property.name)
        || (use?.type === "AssignmentExpression" && use.left === member)
        || use?.type === "UpdateExpression" || (use?.type === "UnaryExpression" && use.operator === "delete")) tainted.add("import.meta");
    }
    if (node.type !== "Identifier") continue;
    const parent = parents.get(node);
    const binding = imports.get(node.name);
    if (binding?.name === "*" && /^(?:node:)?(?:path|url)$/.test(binding.source)
      && !parent?.type.startsWith("Import")) {
      if (parent?.type !== "MemberExpression" || parent.object !== node
        || parents.get(parent)?.type !== "CallExpression" || parents.get(parent).callee !== parent) tainted.add(node.name);
    }
    if (node.name === "URL" && !(parent?.type === "NewExpression" && parent.callee === node)) tainted.add("URL");
  }
  const unique = (name) => declarations.get(name) === 1;
  const member = (node, name) => node?.type === "MemberExpression" && !node.computed && node.property.name === name;
  const importMeta = node => node?.type === "MetaProperty" && node.meta.name === "import" && node.property.name === "meta";
  function imported(node, source, name) {
    if (node?.type === "Identifier" && unique(node.name) && !tainted.has(node.name)) {
      const entry = imports.get(node.name);
      return entry && source.test(entry.source) && entry.name === name;
    }
    if (member(node, name) && node.object.type === "Identifier" && unique(node.object.name) && !tainted.has(node.object.name)) {
      const entry = imports.get(node.object.name);
      return entry && source.test(entry.source) && entry.name === "*";
    }
    return false;
  }
  function evaluate(node, seen = new Set()) {
    if (!node) return undefined;
    if (node.type === "Literal" && typeof node.value === "string") return node.value;
    if (node.type === "TemplateLiteral" && !node.expressions.length) return node.quasis[0].value.cooked;
    if (node.type === "Identifier" && unique(node.name) && constants.has(node.name) && !seen.has(node.name)) {
      const value = evaluate(constants.get(node.name), new Set([...seen, node.name]));
      return typeof value === "string" ? value : undefined;
    }
    if (node.type === "Identifier" && !declarations.has(node.name)) {
      if (node.name === "__dirname") return path.dirname(file);
      if (node.name === "__filename") return file;
    }
    if (node.type === "MemberExpression" && importMeta(node.object) && !node.computed && !tainted.has("import.meta")) {
      if (node.property.name === "url") return pathToFileURL(file).href;
      if (node.property.name === "dirname") return path.dirname(file);
      if (node.property.name === "filename") return file;
    }
    if (node.type === "NewExpression" && node.callee.name === "URL" && !declarations.has("URL") && !tainted.has("URL") && node.arguments.length === 2) {
      const args = node.arguments.map(arg => evaluate(arg, seen));
      if (args.every(arg => typeof arg === "string")) {
        try { return new URL(...args); } catch { return undefined; }
      }
    }
    if (node.type === "CallExpression") {
      const args = node.arguments.map(arg => evaluate(arg, seen));
      if (imported(node.callee, /^(?:node:)?url$/, "fileURLToPath") && args.length === 1) {
        try { return fileURLToPath(args[0]); } catch { return undefined; }
      }
      if (args.every(arg => typeof arg === "string")) {
        for (const method of ["resolve", "join", "dirname"]) {
          if (!imported(node.callee, /^(?:node:)?path$/, method)) continue;
          if (!args.length || !path.isAbsolute(args[0]) || (method === "dirname" && args.length !== 1)) return undefined;
          return path[method](...args);
        }
      }
    }
    return undefined;
  }
  const covered = new Set(), invalid = new Set(), inputs = new Map();
  for (const node of nodes) {
    if (node.type !== "Identifier" || !filesystem.test(imports.get(node.name)?.source ?? "")) continue;
    const binding = imports.get(node.name), parent = parents.get(node);
    if (parent?.type.startsWith("Import")) continue;
    let target = node, method = binding.name;
    if (!unique(node.name)) { invalid.add(binding.source); continue; }
    if (method === "*" || method === "promises") {
      target = parent;
      if (method === "*" && member(target, "promises")) target = parents.get(target);
      if (target?.type !== "MemberExpression" || target.computed) { invalid.add(binding.source); continue; }
      method = target.property.name;
    }
    const call = parents.get(target);
    if (!readers.has(method) || call?.type !== "CallExpression" || call.callee !== target) {
      invalid.add(binding.source); continue;
    }
    let input = evaluate(call.arguments[0]);
    if (input instanceof URL) {
      try { input = fileURLToPath(input); } catch { input = undefined; }
    }
    if (typeof input !== "string" || !path.isAbsolute(input)) { invalid.add(binding.source); continue; }
    covered.add(binding.source);
    const values = inputs.get(binding.source) ?? new Set();
    values.add(path.resolve(input)); inputs.set(binding.source, values);
  }
  return {
    covered: [...covered].filter(source => !invalid.has(source)),
    inputs: [...new Set([...inputs.values()].flatMap(values => [...values]))],
  };
}
