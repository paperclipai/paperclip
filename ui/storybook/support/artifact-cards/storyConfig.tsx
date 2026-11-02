import type { Decorator } from "@storybook/react-vite";

// Layout only; no demo heading or text is rendered around the card.
export const decorators: Decorator[] = [
  (Story) => (
    <div className="w-full max-w-lg">
      <Story />
    </div>
  ),
];
export const parameters = {
  layout: "padded",
  controls: {
    expanded: false,
    exclude: ["onOpen", "actions", "statusBadge", "expanded"],
  },
  docs: {
    description: {
      component:
        "One card. Every artifact-specific value is editable in Controls. Labels and actions are fixed component copy. No live API requests.",
    },
  },
};
export const textData = (description: string) => ({
  control: { type: "text" as const },
  description,
  table: { category: "Artifact data" },
});
export const numberData = (description: string) => ({
  control: { type: "number" as const, min: 0 },
  description,
  table: { category: "Artifact data" },
});
export const objectData = (description: string) => ({
  control: { type: "object" as const },
  description,
  table: { category: "Artifact content" },
});
export const identityControls = {
  title: textData("Artifact title. This is example data, not fixed UI copy."),
  summary: textData(
    "Optional artifact summary. Clear it to remove the paragraph.",
  ),
  author: textData("Author name supplied by the artifact."),
  updatedAt: textData("Display date supplied by the artifact."),
};
export const diffControls = {
  additions: numberData("Added lines from the change metadata."),
  deletions: numberData("Deleted lines from the change metadata."),
  filesChanged: numberData("Number of changed files."),
};
