import type { LabArtifact } from "../../kit";

/** The smallest artifact the kit's pure helpers accept; tests override what they care about. */
export function testArtifact(overrides: Partial<LabArtifact> & Pick<LabArtifact, "kind">): LabArtifact {
  return {
    id: "a",
    title: "An artifact",
    author: "Designer",
    updatedAt: "2026-09-28T11:07:00",
    updatedLabel: "Sep 28, 2026, 11:07 AM",
    dayLabel: "Monday, September 28",
    taskIdentifier: "ACM-3",
    taskTitle: "A task",
    ...overrides,
  };
}
