import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { featureIndex, mapIndexes, pageInventory, sidebarLabel } from "./feature-map.mjs";

export { featureIndex, sidebarLabel } from "./feature-map.mjs";
export const generatedRoot = "ui/storybook/generated";
export const generatedPreview = "ui/storybook/.storybook/preview.tsx";

export function featureOrder(index) {
  return ["Overview", ...index.sections.flatMap(section => [sidebarLabel(section.title),
    section.features.flatMap(feature => [sidebarLabel(feature.title), ["Overview", "*"]]),
  ]), "Foundations"];
}

export function featureArtifacts(index) {
  const outputs = new Map([
    [`${generatedRoot}/feature-index.json`, JSON.stringify(index, null, 2) + "\n"],
    [generatedPreview, [
      'import type { Preview } from "@storybook/react-vite";',
      'import base from "./preview-base";',
      "",
      "const preview: Preview = {",
      "  ...base,",
      "  parameters: {",
      "    ...base.parameters,",
      "    options: {",
      "      ...base.parameters?.options,",
      `      storySort: { order: ${JSON.stringify(featureOrder(index))} },`,
      "    },",
      "  },",
      "};",
      "export default preview;",
      "",
    ].join("\n")],
    ...mapIndexes(index),
  ]);
  for (const section of index.sections) {
    for (const feature of section.features) {
      outputs.set(`${generatedRoot}/features/${feature.id}.stories.tsx`, [
        'import type { Meta, StoryObj } from "@storybook/react-vite";',
        'import { FeatureOverview } from "../../support/feature-map/FeatureOverview";',
        "",
        "const meta = {",
        `  id: ${JSON.stringify(`feature-map-${feature.id}`)},`,
        `  title: ${JSON.stringify(`${sidebarLabel(section.title)}/${sidebarLabel(feature.title)}/Overview`)},`,
        "  component: FeatureOverview,",
        `  args: { area: ${JSON.stringify(feature.id)} },`,
        '  tags: ["!autodocs"],',
        '  parameters: { layout: "fullscreen" },',
        "} satisfies Meta<typeof FeatureOverview>;",
        "export default meta;",
        "export const Overview: StoryObj<typeof meta> = {};",
        "",
      ].join("\n"));
    }
  }
  return outputs;
}

export function writeArtifacts(root, outputs) {
  for (const [file, content] of outputs) {
    const destination = path.join(root, file);
    if (existsSync(destination) && readFileSync(destination, "utf8") === content) continue;
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
}

export function generateFeatureArtifacts(root, index = featureIndex(root)) {
  const outputs = featureArtifacts(index);
  outputs.set("maps/generated/coverage.json", JSON.stringify(pageInventory(root, index), null, 2) + "\n");
  const directory = `${generatedRoot}/features`;
  if (existsSync(path.join(root, directory))) {
    for (const name of readdirSync(path.join(root, directory))) {
      const file = `${directory}/${name}`;
      if (name.endsWith(".stories.tsx") && !outputs.has(file)) rmSync(path.join(root, file), { force: true });
    }
  }
  writeArtifacts(root, outputs);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateFeatureArtifacts(fileURLToPath(new URL("..", import.meta.url)));
}
