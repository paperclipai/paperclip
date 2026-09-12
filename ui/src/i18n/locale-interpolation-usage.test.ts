// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API, type Project, type Symbol as CompilerSymbol } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  isAsExpression, isBindingElement, isCallExpression, isIdentifier,
  isImportClause, isImportDeclaration, isImportSpecifier, isNamespaceImport,
  isNoSubstitutionTemplateLiteral, isNonNullExpression, isNumericLiteral,
  isObjectLiteralExpression, isParenthesizedExpression, isPrefixUnaryExpression,
  isPropertyAccessExpression, isPropertyAssignment, isSatisfiesExpression,
  isShorthandPropertyAssignment, isSpreadAssignment, isStringLiteral,
  isVariableDeclaration, SyntaxKind, type CallExpression, type Node,
} from "typescript/unstable/ast";
import en from "./locales/en.json";
import ru from "./locales/ru.json";

/*
 * Conservative call-site guard, not proof of complete UI localization coverage.
 * Checks bound t(...) / i18n.t(...) calls with literal keys and literal options.
 * Skips aliases, Trans JSX, dynamic keys/options, spreads, replace, context,
 * custom namespaces and unresolved interpolation settings. It checks property
 * presence, not runtime definedness or nested object validity. Unknown plural
 * counts only require fields shared by all reachable forms in a locale.
 *
 * TypeScript 7 exposes its AST through the native API, not createSourceFile.
 * The virtual project is parse/binding-only: no emit, disk writes, network,
 * repo tsconfig loading or application execution. Close the API in finally.
 */
type Catalogs = Record<string, Record<string, string>>;
type Finding = { file: string; line: number; key: string; missing: string[] };
type Report = {
  files: number; calls: number; checked: number; interpolated: number;
  plural: number; formattedCount: number; skipped: Record<string, number>;
  findings: Finding[];
};
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const virtualRoot = resolve(sourceRoot, ".interpolation-audit-virtual");

function flatten(value: unknown, prefix = "", result: Record<string, string> = {}) {
  if (!value || typeof value !== "object") return result;
  for (const [name, child] of Object.entries(value)) {
    const key = prefix ? `${prefix}.${name}` : name;
    if (typeof child === "string") result[key] = child;
    else flatten(child, key, result);
  }
  return result;
}
const actualCatalogs: Catalogs = { en: flatten(en), ru: flatten(ru) };

function unwrap(node: Node): Node {
  while (isAsExpression(node) || isSatisfiesExpression(node) || isNonNullExpression(node) || isParenthesizedExpression(node)) node = node.expression;
  return node;
}
function text(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  node = unwrap(node);
  return isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}
function number(node: Node | undefined): number | undefined {
  if (!node) return undefined;
  node = unwrap(node);
  if (isNumericLiteral(node)) return Number(node.text);
  if (isPrefixUnaryExpression(node) && isNumericLiteral(node.operand)) {
    if (node.operator === SyntaxKind.MinusToken) return -Number(node.operand.text);
    if (node.operator === SyntaxKind.PlusToken) return Number(node.operand.text);
  }
  return undefined;
}
function properties(node: Node): { props: Map<string, Node> } | { skip: string } {
  node = unwrap(node);
  if (!isObjectLiteralExpression(node)) return { skip: "dynamic-options" };
  const props = new Map<string, Node>();
  for (const property of node.properties) {
    if (isSpreadAssignment(property)) return { skip: "spread-options" };
    if (isShorthandPropertyAssignment(property)) {
      if (!isIdentifier(property.name)) return { skip: "unknown-option-property" };
      props.set(property.name.text, property.name);
      continue;
    }
    if (!isPropertyAssignment(property)) return { skip: "unknown-option-property" };
    const name = isIdentifier(property.name) ? property.name.text : text(property.name);
    if (name === undefined) return { skip: "computed-option-property" };
    props.set(name, property.initializer);
  }
  return { props };
}
function importFromI18n(declaration: Node, exportedName: "t" | "i18n" | "useTranslation"): boolean {
  if (!isImportSpecifier(declaration) && !isImportClause(declaration) && !isNamespaceImport(declaration)) return false;
  let ancestor: Node | undefined = declaration;
  while (ancestor && !isImportDeclaration(ancestor)) ancestor = ancestor.parent;
  if (!ancestor || !isImportDeclaration(ancestor)) return false;
  const module = text(ancestor.moduleSpecifier);
  if (!module || !(/(?:^|\/)i18n(?:\/index)?$/.test(module) || module === "react-i18next" || module === "i18next")) return false;
  if (isImportSpecifier(declaration)) return (declaration.propertyName ?? declaration.name).text === exportedName;
  return exportedName === "i18n" && (isNamespaceImport(declaration) || module === "i18next");
}
function isTranslationBinding(symbol: CompilerSymbol | undefined, project: Project, allowHook: boolean): boolean {
  return symbol?.declarations.some((handle) => {
    const declaration = handle.resolve();
    if (!declaration) return false;
    if (importFromI18n(declaration, allowHook ? "t" : "i18n")) return true;
    if (!allowHook || !isBindingElement(declaration)) return false;
    const property = declaration.propertyName ?? declaration.name;
    if (!property || !isIdentifier(property) || property.text !== "t") return false;
    const variable = declaration.parent.parent;
    if (!isVariableDeclaration(variable) || !variable.initializer) return false;
    const initializer = unwrap(variable.initializer);
    if (!isCallExpression(initializer) || !isIdentifier(initializer.expression) || initializer.expression.text !== "useTranslation") return false;
    const hook = project.checker.getSymbolAtLocation(initializer.expression);
    return hook?.declarations.some((node) => { const decl = node.resolve(); return !!decl && importFromI18n(decl, "useTranslation"); }) ?? false;
  }) ?? false;
}
function interpolationFields(template: string, prefix: string, suffix: string): string[] {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`${escape(prefix)}\\s*-?\\s*([^]*?)\\s*${escape(suffix)}`, "g");
  return [...new Set([...template.matchAll(regex)].map((match) => match[1]!.split(",")[0]!.trim()).filter(Boolean))];
}
function templatesFor(catalog: Record<string, string>, locale: string, key: string, props: Map<string, Node>) {
  const direct = catalog[key];
  const forms = ["zero", "one", "two", "few", "many", "other"].filter((form) => Object.hasOwn(catalog, `${key}_${form}`));
  if (!forms.length || (!props.has("count") && direct !== undefined)) return { templates: direct === undefined ? [] : [direct], plural: false };
  const count = number(props.get("count"));
  if (count !== undefined && Number.isFinite(count)) {
    const category = count === 0 && forms.includes("zero") ? "zero" : new Intl.PluralRules(locale).select(count);
    // locales.ts fills missing CLDR categories from _other before i18next uses them.
    const selected = catalog[`${key}_${category}`] ?? catalog[`${key}_other`] ?? direct;
    return { templates: selected === undefined ? [] : [selected], plural: true };
  }
  return { templates: forms.map((form) => catalog[`${key}_${form}`]!), plural: true };
}

function audit(sources: Record<string, string>, catalogs: Catalogs): Report {
  const report: Report = { files: Object.keys(sources).length, calls: 0, checked: 0, interpolated: 0, plural: 0, formattedCount: 0, skipped: {}, findings: [] };
  const skip = (reason: string) => { report.skipped[reason] = (report.skipped[reason] ?? 0) + 1; };
  const files = Object.fromEntries(Object.entries(sources).map(([name, content]) => [resolve(virtualRoot, name), content]));
  const configFile = join(virtualRoot, "tsconfig.json");
  const api = new API({ cwd: sourceRoot, fs: createVirtualFileSystem({
    ...files,
    [configFile]: JSON.stringify({ compilerOptions: { noLib: true, noResolve: true, allowJs: true, jsx: "preserve" }, files: Object.keys(files) }),
  }) });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [configFile] });
    try {
      const project = snapshot.getProject(configFile);
      if (!project) throw new Error("Could not create the read-only interpolation audit project");
      expect(project.program.getSyntacticDiagnostics()).toEqual([]);
      for (const name of Object.keys(files)) {
        const source = project.program.getSourceFile(name);
        if (!source) throw new Error(`Source was not parsed: ${name}`);
        const calls: CallExpression[] = [];
        function visit(node: Node) {
          if (isCallExpression(node)) {
            const callee = unwrap(node.expression);
            if (isIdentifier(callee) && callee.text === "t" || isPropertyAccessExpression(callee) && callee.name.text === "t") calls.push(node);
          }
          node.forEachChild(visit);
        }
        visit(source);
        const locations = calls.map((call) => { const callee = unwrap(call.expression); return isPropertyAccessExpression(callee) ? callee.expression : callee; });
        const symbols = project.checker.getSymbolAtLocation(locations);
        calls.forEach((call, index) => {
          report.calls++;
          const callee = unwrap(call.expression);
          if (!isTranslationBinding(symbols[index], project, isIdentifier(callee))) return skip("unproven-binding");
          let key = text(call.arguments[0]);
          if (key === undefined) return skip("dynamic-key");
          if (call.arguments.length > 2) return skip("additional-arguments");
          const options = call.arguments[1] ? properties(call.arguments[1]) : { props: new Map<string, Node>() };
          if ("skip" in options) return skip(options.skip);
          const { props } = options;
          for (const option of ["replace", "context", "ordinal", "keyPrefix"]) if (props.has(option)) return skip(`${option}-options`);
          if (props.has("ns") && text(props.get("ns")) !== "translation") return skip("namespace-options");
          if (key.startsWith("translation:")) key = key.slice("translation:".length);
          else if (key.includes(":")) return skip("namespace-key");
          let prefix = "{{", suffix = "}}";
          if (props.has("interpolation")) {
            const custom = properties(props.get("interpolation")!);
            if ("skip" in custom || custom.props.has("defaultVariables")) return skip("interpolation-options");
            prefix = custom.props.has("prefix") ? text(custom.props.get("prefix")) ?? "" : prefix;
            suffix = custom.props.has("suffix") ? text(custom.props.get("suffix")) ?? "" : suffix;
            if (!prefix || !suffix) return skip("interpolation-options");
          }
          const lng = props.has("lng") ? text(props.get("lng")) : undefined;
          if (props.has("lng") && (!lng || !catalogs[lng])) return skip("locale-options");
          const required = new Set<string>(), possible = new Set<string>();
          let plural = false;
          for (const [locale, catalog] of Object.entries(catalogs)) {
            if (lng && lng !== locale) continue;
            const selected = templatesFor(catalog, locale, key, props);
            if (!selected.templates.length) return skip("unresolved-key");
            plural ||= selected.plural;
            const fieldSets = selected.templates.map((template) => interpolationFields(template, prefix, suffix));
            for (const field of fieldSets.flat()) possible.add(field);
            for (const field of fieldSets[0]!) if (fieldSets.every((fields) => fields.includes(field))) required.add(field);
          }
          const missing = [...required].filter((field) => !props.has(field.split(".")[0]!));
          if (plural && !props.has("count")) missing.push("[plural selector count]");
          if (!missing.length && [...possible].some((field) => !props.has(field.split(".")[0]!))) return skip("ambiguous-plural-fields");
          report.checked++;
          if (possible.size) report.interpolated++;
          if (plural) report.plural++;
          if (possible.has("formattedCount")) report.formattedCount++;
          if (missing.length) report.findings.push({ file: relative(virtualRoot, name), line: source.getLineAndCharacterOfPosition(call.getStart()).line + 1, key, missing });
        });
      }
    } finally { snapshot.dispose(); }
  } finally { api.close(); }
  return report;
}

function fixture(source: string, catalogs: Catalogs = actualCatalogs) {
  return audit({ "fixture.tsx": `import { t, i18n, useTranslation } from "@/i18n";\n${source}` }, catalogs);
}
function productionSources(directory = sourceRoot): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["__tests__", "__mocks__", "fixtures", "__fixtures__"].includes(entry.name)) continue;
    const file = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, productionSources(file));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(?:test|spec|stories)\.[^/]+$|\.d\.[cm]?ts$/.test(entry.name)) result[relative(sourceRoot, file)] = readFileSync(file, "utf8");
  }
  return result;
}

describe("conservative interpolation call-site usage", () => {
  it("finds both original Pipelines omissions even with a misleading defaultValue", () => {
    const result = fixture(`
      t("pages.pipelines.builtFromCount", {
        defaultValue: "Built from {{count}} {{noun}}", count: pieceCountTotal, noun: pieceLabel(pieceCountTotal),
      });
      t("pages.pipelines.builtFromCount", {
        defaultValue: "Built from {{count}} {{noun}}", count: pieceCountTotal,
        noun: pieceCountTotal === 1 ? t("pages.pipelines.itemWord") : t("pages.pipelines.itemsWord"),
      });
    `);
    expect(result.findings.map(({ key, missing }) => ({ key, missing }))).toEqual([
      { key: "pages.pipelines.builtFromCount", missing: ["formattedCount"] },
      { key: "pages.pipelines.builtFromCount", missing: ["formattedCount"] },
    ]);
  });

  it("accepts separate numeric selectors and formatted values on imported and hook-bound t", () => {
    const result = fixture(`
      t("pages.pipelines.builtFromCount", { count, formattedCount });
      i18n.t("pages.pipelines.builtFromCount", { count, formattedCount: formatNumber(count) });
      function Component() { const { t } = useTranslation(); return t("pages.pipelines.builtFromCount", { count, formattedCount }); }
    `);
    expect(result.checked).toBe(3);
    expect(result.findings).toEqual([]);
  });

  it.each([
    ["spread-options", `t("pages.pipelines.builtFromCount", {count, ...options})`],
    ["dynamic-options", `t("pages.pipelines.builtFromCount", options)`],
    ["replace-options", `t("pages.pipelines.builtFromCount", {count, replace: {formattedCount}})`],
    ["computed-option-property", `t("pages.pipelines.builtFromCount", {count, [name]: value})`],
    ["dynamic-key", `t(key, {count})`],
    ["context-options", `t("pages.pipelines.builtFromCount", {count, context: context})`],
    ["interpolation-options", `t("pages.pipelines.builtFromCount", {count, interpolation: settings})`],
    ["unproven-binding", `function unrelated(t: Function) { t("pages.pipelines.builtFromCount", {count}); }`],
    ["unresolved-key", `t("not.a.catalog.key", {count})`],
  ])("skips %s instead of failing an unproven call", (reason, source) => {
    const result = fixture(source);
    expect(result.skipped[reason]).toBe(1);
    expect(result.checked).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("respects deliberate custom delimiters around literal template-variable documentation", () => {
    const result = fixture(`
      t("localizationAgents.help_promptTemplate", {interpolation: {prefix: "{{@", suffix: "@}}"}});
      t("localizationAgents.help_workspaceBranchTemplate", {interpolation: {prefix: "{{@", suffix: "@}}"}});
    `);
    expect(result.checked).toBe(2);
    expect(result.findings).toEqual([]);
  });

  it("does not treat a different i18n export or hook property aliased to t as a translation function", () => {
    const result = audit({ "fixture.tsx": `
      import { setLocale as t, setLocale as i18n, useTranslation } from "@/i18n";
      t("pages.pipelines.builtFromCount");
      i18n.t("pages.pipelines.builtFromCount");
      function Component() { const {i18n: t} = useTranslation(); t("pages.pipelines.builtFromCount"); }
    ` }, actualCatalogs);
    expect(result.skipped["unproven-binding"]).toBe(3);
    expect(result.checked).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("uses the reachable CLDR category for a numeric literal, including explicit zero", () => {
    const catalogs = { en: { item_zero: "None", item_one: "One", item_other: "{{name}} items" }, ru: { item_zero: "Нет", item_one: "Один", item_few: "{{name}} элемента", item_many: "{{name}} элементов", item_other: "{{name}} элемента" } };
    expect(fixture(`t("item", {count: 0}); t("item", {count: 1}); t("item", {count: 2, name});`, catalogs).findings).toEqual([]);
    expect(fixture(`t("item", {count: 2});`, catalogs).findings[0]?.missing).toEqual(["name"]);
  });

  it("does not fail unknown counts for fields absent from some reachable plural forms", () => {
    const catalogs = { en: { item_one: "One", item_other: "{{name}} items" }, ru: { item_one: "Один", item_other: "{{name}} элементов" } };
    const result = fixture(`t("item", {count});`, catalogs);
    expect(result.skipped["ambiguous-plural-fields"]).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it("checks both catalogs and detects a missing plural selector", () => {
    expect(fixture(`t("message");`, { en: { message: "Hello" }, ru: { message: "Привет, {{name}}" } }).findings[0]?.missing).toEqual(["name"]);
    expect(fixture(`t("pages.pipelines.builtFromCount", {formattedCount});`).findings[0]?.missing).toEqual(["[plural selector count]"]);
  });

  it("has no proven missing interpolation options in production UI call sites", () => {
    const result = audit(productionSources(), actualCatalogs);
    // Broad floors detect an accidentally empty/narrow scan; these are not an
    // exhaustive-coverage claim. Skipped calls still need runtime/code review.
    expect(result.files).toBeGreaterThan(900);
    expect(result.checked).toBeGreaterThan(14_000);
    expect(result.interpolated).toBeGreaterThan(2_000);
    expect(result.formattedCount).toBeGreaterThanOrEqual(9);
    expect(result.findings, JSON.stringify(result, null, 2)).toEqual([]);
    console.info("Interpolation usage coverage:", JSON.stringify({ ...result, findings: undefined }));
  }, 60_000);
});
