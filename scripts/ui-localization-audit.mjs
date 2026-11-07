import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(repository, 'ui/package.json'));
const { parseSync } = await import(pathToFileURL(require.resolve('vite')).href);
const children = node => Object.entries(node).filter(([key]) => !['comments', 'tokens', 'parent'].includes(key))
  .flatMap(([, value]) => Array.isArray(value) ? value.filter(x => x && typeof x.type === 'string')
    : value && typeof value.type === 'string' ? [value] : []);
const walk = (node, visit, parents = []) => {
  visit(node, parents);
  for (const child of children(node)) walk(child, visit, [...parents, node]);
};
const literal = node => node?.type === 'Literal' ? node.value
  : node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : undefined;
const name = node => node?.name ?? literal(node);

export function inspectTranslationReferences(source, file) {
  const parsed = parseSync(file, source, { sourceType: 'module' });
  if (parsed.errors?.length) throw new Error(`Cannot audit ${file}: ${parsed.errors.map(x => x.message).join('; ')}`);
  const imports = new Map();
  for (const node of parsed.program.body) {
    if (node.type !== 'ImportDeclaration' || !/(?:^|\/)i18n$/.test(node.source.value)) continue;
    for (const specifier of node.specifiers ?? []) {
      if (specifier.type === 'ImportSpecifier' && name(specifier.imported) === 't') imports.set(name(specifier.local), 'translation');
    }
  }
  const hooks = [];
  walk(parsed.program, (node, parents) => {
    if (node.type !== 'VariableDeclarator' || node.id?.type !== 'ObjectPattern'
      || node.init?.type !== 'CallExpression' || !/useTranslation/.test(name(node.init.callee) ?? '')) return;
    const namespace = literal(node.init.arguments[0]) ?? 'translation';
    const scope = [...parents].reverse().find(x => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(x.type)) ?? parsed.program;
    for (const property of node.id.properties ?? []) {
      if (name(property.key) === 't') hooks.push({ name: name(property.value), namespace, start: scope.start, end: scope.end });
    }
  });
  const result = { static: [], dynamic: [] };
  walk(parsed.program, node => {
    if (node.type !== 'CallExpression') return;
    let namespace;
    if (node.callee.type === 'Identifier') {
      const alias = node.callee.name;
      const hook = hooks.filter(x => x.name === alias && node.start >= x.start && node.end <= x.end)
        .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
      namespace = hook?.namespace ?? imports.get(alias);
    } else if (node.callee.type === 'MemberExpression' && name(node.callee.property) === 't' && name(node.callee.object) === 'i18n') {
      namespace = 'translation';
    }
    if (typeof namespace !== 'string') return;
    const reference = { file, line: source.slice(0, node.start).split('\n').length };
    let key = literal(node.arguments[0]);
    if (typeof key !== 'string') {
      result.dynamic.push({ ...reference, expression: source.slice(node.start, node.end) });
      return;
    }
    const options = node.arguments[1];
    if (options?.type === 'ObjectExpression') {
      const field = options.properties.find(x => name(x.key) === 'ns');
      if (field && typeof literal(field.value) === 'string') namespace = literal(field.value);
    }
    const colon = key.indexOf(':');
    if (colon >= 0) { namespace = key.slice(0, colon); key = key.slice(colon + 1); }
    result.static.push({ ...reference, namespace, key });
  });
  return result;
}

export function findMissingReferences(references, resources) {
  return references.flatMap(reference => {
    const missingLanguages = ['en', 'zh-CN'].filter(locale => {
      const messages = resources[locale]?.[reference.namespace];
      return !messages || (!Object.hasOwn(messages, reference.key) && !Object.hasOwn(messages, reference.key + '_other'));
    });
    return missingLanguages.length ? [{ ...reference, missingLanguages }] : [];
  });
}

const files = directory => fs.readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : entry.isFile() ? [path.join(directory, entry.name)] : []);
const flatten = (value, prefix = '', output = {}) => {
  if (typeof value === 'string') output[prefix] = value;
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) flatten(item, prefix ? `${prefix}.${key}` : key, output);
  return output;
};

export function auditUiLocalization(root = repository) {
  const resources = {};
  for (const locale of ['en', 'zh-CN']) {
    resources[locale] = { translation: flatten(JSON.parse(fs.readFileSync(path.join(root, `ui/src/i18n/locales/${locale}.json`), 'utf8'))) };
    const directory = path.join(root, 'ui/src/i18n/catalogs', locale);
    for (const file of files(directory).filter(x => x.endsWith('.json'))) {
      resources[locale][path.basename(file, '.json')] = flatten(JSON.parse(fs.readFileSync(file, 'utf8')));
    }
  }
  const sources = files(path.join(root, 'ui/src')).filter(file => /\.[cm]?tsx?$/.test(file)
    && !/(?:\.(?:test|spec|stories|fixture)\.|\.d\.ts$|\/(?:fixtures|__tests__|__mocks__)\/)/.test(file));
  const references = { static: [], dynamic: [] };
  for (const file of sources) {
    const result = inspectTranslationReferences(fs.readFileSync(file, 'utf8'), path.relative(root, file));
    references.static.push(...result.static);
    references.dynamic.push(...result.dynamic);
  }
  const missing = findMissingReferences(references.static, resources);
  return { sourceFiles: sources.length, staticReferences: references.static.length, missing, dynamicReferences: references.dynamic,
    limitations: ['Dynamic keys require explicit enum or behavior tests.', 'This check does not prove the absence of untranslated source strings.', 'Trans elements and custom translation wrappers require separate review.'] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = auditUiLocalization();
  console.log(JSON.stringify(process.argv.includes('--json') ? report : {
    sourceFiles: report.sourceFiles, staticReferences: report.staticReferences, missing: report.missing,
    dynamicReferences: report.dynamicReferences.length, limitations: report.limitations,
  }, null, 2));
  if (process.argv.includes('--check') && report.missing.length) process.exitCode = 1;
}
