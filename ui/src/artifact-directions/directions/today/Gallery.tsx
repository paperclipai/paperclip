import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { ArtifactGroupCard } from "@/components/artifacts/ArtifactGroupCard";
import type { LabGroup } from "../../kit";
import { issueIdFor, toCompanyArtifact, toCompanyArtifactGroup } from "./adapters";

// pages/Artifacts.tsx:354 — the one grid both views share.
const GRID = "grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3";

/** The shipped stack card, on the page's own grid. */
export function GalleryStacks({ groups }: { groups: LabGroup[] }) {
  return (
    <div className={GRID}>
      {groups.map((group) => (
        <ArtifactGroupCard
          key={group.id}
          group={toCompanyArtifactGroup(group)}
          to={{ search: `?groupIssueId=${issueIdFor(group.taskIdentifier)}` }}
        />
      ))}
    </div>
  );
}

/** The shipped artifact tile, on the page's own grid. */
export function GalleryStack({ group }: { group: LabGroup }) {
  return (
    <div className={GRID}>
      {group.artifacts.map((artifact) => {
        const companyArtifact = toCompanyArtifact(artifact);
        return <ArtifactCard key={`${companyArtifact.source}:${companyArtifact.id}`} artifact={companyArtifact} />;
      })}
    </div>
  );
}
