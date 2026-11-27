// Audited prose inputs, shared by routing, Vitest selection and task hashing.
// Do not broaden this to all Markdown: docs/api, bundled skills, maps, and
// non-Markdown fixtures (e.g. doc/connections/*.json) are runtime/test inputs.
const AUDITED_ROOT_GUIDANCE_DOCS = new Set([
  "doc/CLI.md",
  "doc/DATABASE.md",
  "doc/DEVELOPING.md",
  "doc/GOAL.md",
  "doc/PRODUCT.md",
  "doc/PUBLISHING.md",
  "doc/RELEASING.md",
]);

const AUDITED_DOC_GUIDANCE_DIR =
  /^doc\/(?:architecture|connections|design|experimental|memory|performance|plugins|pr|spec|testing)\/(?:[^/]+\/)*[^/]+\.md$/;

const AUDITED_DOCS_GUIDANCE_DIR =
  /^docs\/(?:adapters|cli|companies|deploy|guides|performance|plans|specs|start)\/(?:[^/]+\/)*[^/]+\.md$/;

const AUDITED_HISTORICAL_DOC = /^doc\/(?:plans|logs)\/(?:[^/]+\/)*[^/]+\.md$/;

export function documentationInput(file) {
  if (typeof file !== "string" || file.split("/").includes("..")) return null;
  if (AUDITED_HISTORICAL_DOC.test(file)) return "historical";
  if (
    AUDITED_ROOT_GUIDANCE_DOCS.has(file)
    || AUDITED_DOC_GUIDANCE_DIR.test(file)
    || AUDITED_DOCS_GUIDANCE_DIR.test(file)
  ) {
    return "guidance";
  }
  return null;
}

export const productInputs = (files) => files.filter((file) => !documentationInput(file));
