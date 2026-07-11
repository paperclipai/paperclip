import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const skillRoot = fileURLToPath(
  new URL("../../../skills/paperclip-create-agent/", import.meta.url),
);
const paperclipSkillRoot = fileURLToPath(
  new URL("../../../skills/paperclip/", import.meta.url),
);

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(absolutePath);
    return entry.isFile() && entry.name.endsWith(".md") ? [absolutePath] : [];
  });
}

describe("paperclip-create-agent bundled guidance", () => {
  it("keeps hire payload examples capability-first instead of prescribing a title", () => {
    const exampleFiles = [
      join(skillRoot, "SKILL.md"),
      join(skillRoot, "references", "api-reference.md"),
    ];

    for (const file of exampleFiles) {
      const content = readFileSync(file, "utf8");
      expect(content, relative(skillRoot, file)).toContain(
        '"capabilities": "<capability gap this hire closes>"',
      );
      expect(content, relative(skillRoot, file)).toContain(
        '"idempotencyKey": "harness:<capability-lane>:v1"',
      );
      expect(content, relative(skillRoot, file)).toMatch(
        /\b(?:never|do not)\s+(?:generate a random key per (?:attempt|retry)|derive it from a role\s+title)/i,
      );
      expect(content, relative(skillRoot, file)).not.toMatch(
        /"(?:name|role|title)"\s*:\s*"(?:cto|chief technology officer|founding[ _-]?engineer)"/i,
      );
      expect(content, relative(skillRoot, file)).not.toMatch(
        /(?:CTO|FoundingEngineer) hire request submitted/i,
      );
    }
  });

  it("forbids assumed live role routes throughout the referenced skill tree", () => {
    const directRoleLink =
      /\[[^\]]+\]\([^\n)]*\/agents\/(?:cto|qa|uxdesigner|securityengineer|coder)(?:[/?#)]|$)/i;
    const imperativeRoleRoute =
      /\b(?:ask|assign|reassign|escalate|loop\s+in|hand(?:\s+\w+){0,2}\s+to|route(?:\s+\w+){0,2}\s+to)\s+(?:the\s+)?(?:cto|qa|ux\s*designer|uxdesigner|security\s*engineer|securityengineer|coder)\b/i;
    const prescribedFirstHire =
      /\bfirst\s+hire\s+(?:is|must\s+be|should\s+be|will\s+be|defaults?\s+to)\s+(?:an?\s+|the\s+)?(?:cto|qa|ux\s*designer|security\s*engineer|coder|founding[ _-]?engineer)\b/i;

    for (const file of markdownFiles(skillRoot)) {
      const content = readFileSync(file, "utf8");
      const name = relative(skillRoot, file);
      expect(content, `${name} contains a title-derived agent link`).not.toMatch(directRoleLink);
      expect(content, `${name} routes work to an assumed title`).not.toMatch(imperativeRoleRoute);
      expect(content, `${name} prescribes a fixed first hire`).not.toMatch(prescribedFirstHire);
    }
  });

  it("marks role templates as examples and requires capability-resolved handoffs", () => {
    const index = readFileSync(
      join(skillRoot, "references", "agent-instruction-templates.md"),
      "utf8",
    );
    expect(index).toContain("Role files are drafting examples");
    expect(index).toMatch(/Never construct an\s+agent link, assignee, or reporting line/);

    for (const template of ["coder.md", "qa.md", "uxdesigner.md", "securityengineer.md"]) {
      const content = readFileSync(join(skillRoot, "references", "agents", template), "utf8");
      expect(content, template).toContain("## Example Role Fields");
      expect(content, template).toMatch(
        /Resolve every .*handoff[\s\S]*current[- ]company[\s\S]*capability/i,
      );
      expect(content, template).toMatch(
        /never derive an assignee or URL\s+slug from a role\s+template name/,
      );
    }
  });

  it("requires the operating-harness assessment to be registered as a document work product", () => {
    const bootstrap = readFileSync(
      join(skillRoot, "references", "operating-harness-bootstrap.md"),
      "utf8",
    );

    expect(bootstrap).toContain("register it as a `document` issue work product");
    expect(bootstrap).toMatch(
      /a comment or unregistered document alone\s+does not satisfy the onboarding completion contract/,
    );
    expect(bootstrap).not.toMatch(/assessment` document or issue comment/i);
  });

  it("does not imply that comments or attachments alone satisfy declared completion evidence", () => {
    const skill = readFileSync(join(paperclipSkillRoot, "SKILL.md"), "utf8");
    const contract = readFileSync(
      join(paperclipSkillRoot, "references", "execution-contract.md"),
      "utf8",
    );

    expect(skill).toContain("declared completion evidence must also be registered");
    expect(contract).toContain(
      "does not satisfy the completion gate",
    );
    expect(contract).toContain("register a `document` work product");
  });
});
