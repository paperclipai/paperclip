import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function mapFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-map-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function write(file, content) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  write("ui/package.json", '{"type":"module"}\n');
  symlinkSync(fileURLToPath(new URL("../ui/node_modules", import.meta.url)), path.join(root, "ui/node_modules"), "junction");
  write(".gitignore", "node_modules/\nmaps/generated/\nui/storybook/generated/\nui/storybook/.storybook/preview.tsx\n");
  write("maps/README.md", "# Maps\n");
  write("maps/feature-map/README.md", "# Feature recipes\n");
  write("maps/agent-access-map/README.md", "# Access contracts\n");
  write("ui/storybook/.storybook/preview-base.tsx", "export default { parameters: { layout: 'fullscreen' } };\n");
  function feature(id, title, capabilities = ["create"], options = {}) {
    const { section = "Work", sectionOrder = 10, order = 10 } = options;
    write(`maps/feature-map/${id}.md`, `---\nnavigation: ${JSON.stringify({ section, sectionOrder, order })}\n---\n\n# ${title}\n\n${title} workflows.\n\n[Agent access](../agent-access-map/${id}.md)\n\n## Sub-features\n\n${capabilities.map(key => `- \`${key}\`: ${key} work.`).join("\n")}\n\n## Gotchas\n`);
    write(`maps/agent-access-map/${id}.md`, `# ${title} access\n\n[Product map](../feature-map/${id}.md)\n\n${capabilities.map(key => `## \`${key}\`\n\nReview: \`baseline\`.\n\nAPI: \`present\` — POST /api/${id}.\nAgent access: \`available\` — REST.\nPolicy: same company.\nEvidence: \`source-only\` — inspect implementation.\nVerification: \`not-run\` — assert access and denial.\nGaps: remaining variants.\n`).join("\n")}`);
  }
  function story(name = "task", metadata = { capabilities: ["tasks/create"], implementation: "production", boundary: "fixtures" }, options = {}) {
    const { area = "tasks", title = `Work/Tasks/${name}`, id = `stable-${name}`, exports = "export const Empty = {};", parameters = "" } = options;
    const file = `ui/storybook/stories/${area}/${name}.stories.tsx`;
    write(file, `import type { Meta } from '@storybook/react-vite';\nconst meta = { id: ${JSON.stringify(id)}, title: ${JSON.stringify(title)}, parameters: { ${parameters} paperclip: ${JSON.stringify(metadata)} } } satisfies Meta;\nexport default meta;\n${exports}\n`);
    return file;
  }
  feature("tasks", "Tasks", ["create", "discussion"]);
  const file = story();
  return { root, write, feature, story, file };
}
