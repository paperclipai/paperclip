import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(path.join(root, "ui/package.json"));
const storybookRequire = createRequire(require.resolve("storybook/internal/csf-tools"));
const { parse } = storybookRequire("@babel/parser");
const traverse = storybookRequire("@babel/traverse").default;

function canonicalImport(source, file) {
  if (source === "@/components/ui/button") return true;
  return source.startsWith(".") && path.posix.normalize(path.posix.join(path.posix.dirname(file), source))
    .replace(/\.[jt]sx?$/, "") === "ui/src/components/ui/button";
}

function propValue(attributes, name, fallback) {
  const explicit = attributes.find(attribute => attribute.type === "JSXAttribute" && attribute.name.name === name);
  if (!explicit) return attributes.some(attribute => attribute.type === "JSXSpreadAttribute") ? "dynamic / spread" : fallback;
  // A subsequent spread may override even an explicit literal.
  if (attributes.slice(attributes.indexOf(explicit) + 1).some(attribute => attribute.type === "JSXSpreadAttribute")) return "dynamic / spread";
  const value = explicit.value?.type === "JSXExpressionContainer" ? explicit.value.expression : explicit.value;
  return value?.type === "StringLiteral" ? value.value : "dynamic";
}

/** Count source call sites, never rendered instances or user activity. */
export function buttonReferences(source, file, scope) {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const entries = [];
  traverse(ast, {
    JSXOpeningElement(element) {
      const name = element.node.name;
      const local = name.type === "JSXIdentifier" ? name.name : name.type === "JSXMemberExpression" && name.object.type === "JSXIdentifier" ? name.object.name : null;
      if (!local) return;
      const binding = element.scope.getBinding(local);
      if (!binding || !canonicalImport(binding.path.parent.source?.value ?? "", file)) return;
      const importedButton = binding.path.isImportSpecifier() && (binding.path.node.imported.name ?? binding.path.node.imported.value) === "Button" && name.type === "JSXIdentifier";
      const namespaceButton = binding.path.isImportNamespaceSpecifier() && name.type === "JSXMemberExpression" && name.property.name === "Button";
      if (!importedButton && !namespaceButton) return;
      entries.push({ file, line: element.node.loc.start.line, scope,
        variant: propValue(element.node.attributes, "variant", "default"),
        size: propValue(element.node.attributes, "size", "default"),
      });
    },
  });
  return entries;
}

function walk(directory) {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const file = `${directory}/${entry.name}`;
    return entry.isDirectory() ? walk(file) : /\.tsx$/.test(file) && !/\.(test|spec|stories)\.tsx$/.test(file) ? [file] : [];
  });
}

function inventory() {
  const roots = [["ui/src", "app"]];
  const entries = roots.flatMap(([directory, scope]) => walk(directory).flatMap(file => {
    const source = readFileSync(path.join(root, file), "utf8");
    // Parsing is unnecessary for modules that cannot import the subject.
    return /\bButton\b/.test(source) ? buttonReferences(source, file, scope) : [];
  }));
  return { entries: entries.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line) };
}

/** Storybook-only module: publish counts and locations, without bundling app source text. */
export function storybookButtonUsage() {
  const id = "virtual:paperclip-button-usage";
  return {
    name: "paperclip-button-usage",
    resolveId(value) { if (value === id) return `\0${id}`; },
    load(value) { if (value === `\0${id}`) return `export default ${JSON.stringify(inventory())};`; },
    handleHotUpdate(context) {
      if (!/\/ui\/src\/.*\.tsx$/.test(context.file)) return;
      const module = context.server.moduleGraph.getModuleById(`\0${id}`);
      if (module) { context.server.moduleGraph.invalidateModule(module); return [...context.modules, module]; }
    },
  };
}
