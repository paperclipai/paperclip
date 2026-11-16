// Audited prose inputs, shared by routing, Vitest selection and task hashing.
// Do not broaden this to all Markdown: docs/api and bundled skills are runtime inputs.
export function documentationInput(file) {
  if (file === "doc/DEVELOPING.md" || file === "doc/DATABASE.md") return "guidance";
  if (/^doc\/plans\/(?:[^/]+\/)*[^/]+\.md$/.test(file)
    && !file.split("/").includes("..")) return "historical";
  return null;
}

export const productInputs = (files) => files.filter((file) => !documentationInput(file));
