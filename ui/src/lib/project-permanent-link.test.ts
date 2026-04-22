import { describe, expect, it } from "vitest";
import { buildProjectPermanentUrl, permanentProjectPath } from "./project-permanent-link";

const projectId = "123e4567-e89b-12d3-a456-426614174000";

describe("project permanent links", () => {
  it("replaces a company-prefixed project slug with the project UUID", () => {
    expect(
      buildProjectPermanentUrl({
        origin: "http://localhost:3100",
        pathname: "/PAP/projects/paperclip-app/issues",
        projectId,
      }),
    ).toBe(`http://localhost:3100/PAP/projects/${projectId}/issues`);
  });

  it("preserves nested project tabs", () => {
    expect(permanentProjectPath("/PAP/projects/paperclip-app/context", projectId)).toEqual({
      path: `/PAP/projects/${projectId}/context`,
      replaced: true,
    });
    expect(permanentProjectPath("/PAP/projects/paperclip-app/source", projectId)).toEqual({
      path: `/PAP/projects/${projectId}/source`,
      replaced: true,
    });
    expect(permanentProjectPath("/PAP/projects/paperclip-app/configuration", projectId)).toEqual({
      path: `/PAP/projects/${projectId}/configuration`,
      replaced: true,
    });
    expect(permanentProjectPath("/PAP/projects/paperclip-app/budget", projectId)).toEqual({
      path: `/PAP/projects/${projectId}/budget`,
      replaced: true,
    });
    expect(permanentProjectPath("/PAP/projects/paperclip-app/issues/backlog", projectId)).toEqual({
      path: `/PAP/projects/${projectId}/issues/backlog`,
      replaced: true,
    });
  });

  it("preserves plugin search params and hashes when replacing a project path", () => {
    expect(
      buildProjectPermanentUrl({
        origin: "http://localhost:3100/",
        pathname: "/PAP/projects/paperclip-app",
        projectId,
        search: "?tab=plugin%3Atools%3Asummary",
        hash: "#notes",
      }),
    ).toBe(`http://localhost:3100/PAP/projects/${projectId}?tab=plugin%3Atools%3Asummary#notes`);
  });

  it("falls back to the project detail path when there is no project segment", () => {
    expect(
      buildProjectPermanentUrl({
        origin: "http://localhost:3100",
        pathname: "/PAP/dashboard",
        projectId,
        search: "?ignored=true",
        hash: "#ignored",
      }),
    ).toBe(`http://localhost:3100/projects/${projectId}`);
  });
});
