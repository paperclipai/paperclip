import type { ArtifactSubject } from "./kinds";

export function testSubject(overrides: Partial<ArtifactSubject> & Pick<ArtifactSubject, "kind">): ArtifactSubject {
  return { title: "An artifact", updatedAt: "2026-09-28T11:07:00", taskIdentifier: "ACM-3", ...overrides };
}
