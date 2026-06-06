import type { Meta, StoryObj } from "@storybook/react-vite";
import { Package } from "lucide-react";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { EmptyState } from "@/components/EmptyState";
import type { CompanyArtifact } from "@/api/artifacts";

/**
 * Storybook coverage for the company Artifacts page (PAP-10359). Renders the
 * responsive three-column grid and every preview card variant with mock data so
 * UX/QA can review the layout and capture desktop/mobile screenshots without a
 * live backend.
 */

const SAMPLE_IMAGE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='480' height='270'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#6366f1'/><stop offset='1' stop-color='#22d3ee'/></linearGradient></defs><rect width='480' height='270' fill='url(#g)'/><text x='50%' y='52%' font-family='sans-serif' font-size='28' fill='white' text-anchor='middle'>Hero render.png</text></svg>`,
  );

function makeArtifact(overrides: Partial<CompanyArtifact>): CompanyArtifact {
  return {
    id: "art",
    source: "attachment",
    mediaKind: "image",
    title: "Artifact",
    previewText: null,
    contentType: null,
    contentPath: null,
    openPath: null,
    downloadPath: null,
    issue: { id: "issue-1", identifier: "PAP-10306", title: "Landing visuals refresh" },
    project: { id: "proj-1", name: "Paperclip App" },
    createdByAgent: { id: "agent-1", name: "ClaudeCoder" },
    updatedAt: new Date("2026-06-04T12:00:00Z").toISOString(),
    href: "/issues/PAP-10306#attachment-art",
    ...overrides,
  };
}

const ARTIFACTS: CompanyArtifact[] = [
  makeArtifact({
    id: "wp-video",
    source: "work_product",
    mediaKind: "video",
    title: "Product demo — primary cut.mp4",
    contentType: "video/mp4",
    contentPath: null, // exercises the calm video placeholder + play glyph
    openPath: "/files/demo.mp4",
    downloadPath: "/files/demo.mp4?download=1",
    issue: { id: "issue-2", identifier: "PAP-10205", title: "Record the launch walkthrough" },
    href: "/issues/PAP-10205#work-product-wp-video",
  }),
  makeArtifact({
    id: "img-hero",
    mediaKind: "image",
    title: "Hero render.png",
    contentType: "image/png",
    contentPath: SAMPLE_IMAGE,
    openPath: SAMPLE_IMAGE,
    downloadPath: SAMPLE_IMAGE,
  }),
  makeArtifact({
    id: "doc-plan",
    source: "document",
    mediaKind: "document",
    title: "Artifacts Page Plan",
    previewText:
      "Build a company-level Artifacts page at /{companyPrefix}/artifacts, with a sidebar item below Goals and a three-column artifact grid. The page should make agent-produced work easy to find without becoming another attachment dump.",
    contentType: "text/markdown",
    issue: { id: "issue-3", identifier: "PAP-10341", title: "Draft the rollout plan" },
    createdByAgent: { id: "agent-2", name: "CodexCoder" },
    href: "/issues/PAP-10341#document-plan",
  }),
  makeArtifact({
    id: "txt-notes",
    mediaKind: "text",
    title: "review-notes.txt",
    previewText:
      "Reviewed the primary cut. Color grade looks good; trim the first 1.2s of dead air. Re-export at 1080p and attach the final to the issue.",
    contentType: "text/plain",
    openPath: "/files/review-notes.txt",
    downloadPath: "/files/review-notes.txt?download=1",
    issue: { id: "issue-2", identifier: "PAP-10205", title: "Record the launch walkthrough" },
  }),
  makeArtifact({
    id: "file-zip",
    mediaKind: "file",
    title: "design-assets.zip",
    contentType: "application/zip",
    openPath: "/files/design-assets.zip",
    downloadPath: "/files/design-assets.zip?download=1",
    issue: { id: "issue-1", identifier: "PAP-10306", title: "Landing visuals refresh" },
  }),
  makeArtifact({
    id: "img-broken",
    mediaKind: "image",
    title: "missing-preview.png (broken source)",
    contentType: "image/png",
    contentPath: "/files/does-not-exist.png", // exercises the onError image fallback
    openPath: "/files/does-not-exist.png",
    downloadPath: "/files/does-not-exist.png?download=1",
  }),
];

function ArtifactsGrid({ artifacts }: { artifacts: CompanyArtifact[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {artifacts.map((artifact) => (
        <ArtifactCard key={`${artifact.source}:${artifact.id}`} artifact={artifact} />
      ))}
    </div>
  );
}

const meta: Meta = {
  title: "Pages/Artifacts",
};

export default meta;

type Story = StoryObj;

export const Grid: Story = {
  render: () => (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <p className="text-sm text-muted-foreground">
        Work your agents have produced — documents, media, and files — across this company's issues.
      </p>
      <ArtifactsGrid artifacts={ARTIFACTS} />
    </div>
  ),
};

export const Empty: Story = {
  render: () => (
    <div className="mx-auto max-w-6xl p-6">
      <EmptyState
        icon={Package}
        message="No artifacts yet. Agent-produced documents, media, and files will appear here."
      />
    </div>
  ),
};
