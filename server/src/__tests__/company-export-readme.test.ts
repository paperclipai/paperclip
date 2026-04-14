import { describe, expect, it } from "vitest";
import { generateReadme } from "../services/company-export-readme.js";

describe("company export readme", () => {
  it("renders Orchestrero branding without upstream Paperclip links", () => {
    const readme = generateReadme(
      {
        schemaVersion: "agentcompanies/v1",
        company: {
          slug: "orchestrero-demo",
          file: "COMPANY.md",
          homepage: null,
        },
        agents: [],
        projects: [],
        issues: [],
        skills: [],
        routines: [],
      },
      {
        companyName: "Demo Company",
        companyDescription: "A demo export",
      },
    );

    expect(readme).toContain("[Orchestrero](https://www.orchestrero.ai)");
    expect(readme).not.toContain("paperclip.ing");
    expect(readme).not.toContain("github.com/paperclip");
  });

  it("renders skill source metadata without markdown links", () => {
    const readme = generateReadme(
      {
        schemaVersion: "agentcompanies/v1",
        company: {
          slug: "orchestrero-demo",
          file: "COMPANY.md",
          homepage: null,
        },
        agents: [],
        projects: [],
        issues: [],
        routines: [],
        skills: [
          {
            sourceType: "github",
            sourceLocator: "https://github.com/example/example/blob/main/skills/coordination.md",
            name: "Coordination",
            description: "Coordinate team actions.",
          },
        ],
      },
      {
        companyName: "Demo Company",
        companyDescription: "A demo export",
      },
    );

    expect(readme).not.toContain("[github](");
    expect(readme).toContain("github: `https://github.com/example/example/blob/main/skills/coordination.md`");
    expect(readme).toContain("### Skills");
  });
});
