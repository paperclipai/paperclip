import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The OKF skill ships dependency-free `.mjs` tools. We load them through a
// computed URL so `tsc` treats the import as dynamic `any` (the scripts carry
// no .d.ts), while vitest resolves the real modules at runtime. This keeps the
// scripts self-contained for install while still unit-testing their logic.
const skillScripts = new URL(
  "../catalog/optional/knowledge/okf-knowledge/scripts/",
  import.meta.url,
);
const sampleBundleDir = fileURLToPath(
  new URL("../catalog/optional/knowledge/okf-knowledge/sample-bundle", import.meta.url),
);

async function load(name: string): Promise<any> {
  return import(new URL(name, skillScripts).href);
}

let buildOkfBundle: (dump: any, opts?: any) => Array<{ path: string; content: string }>;
let validateOkfBundle: (dir: string) => {
  ok: boolean;
  errors: string[];
  warnings: string[];
  conceptCount: number;
  fileCount: number;
};
let parseFrontmatter: (text: string) => { hasFrontmatter: boolean; frontmatter: any; error?: string };

beforeAll(async () => {
  ({ buildOkfBundle } = await load("okf-export.mjs"));
  ({ validateOkfBundle, parseFrontmatter } = await load("okf-validate.mjs"));
});

const dump = {
  company: { name: "Acme Robotics", prefix: "ACME", exportedAt: "2026-06-14T10:00:00Z" },
  memories: [
    {
      name: "deploy-window-policy",
      title: "Deploy window policy",
      description: "Deploys ship Tue/Thu only.",
      type: "project",
      tags: ["ops"],
      timestamp: "2026-05-02T09:00:00Z",
      body: "Deploys restricted to Tue/Thu.",
    },
  ],
  skills: [{ name: "postmortem", title: "Postmortem", description: "Blameless writeups." }],
  decisions: [
    {
      identifier: "ACME-318",
      title: "Pick Postgres",
      summary: "Relational integrity won.",
      outcome: "Approved.",
      body: "We compared options.",
      citations: [{ title: "Bench", url: "https://example.com/b" }],
    },
  ],
  docs: [{ issueIdentifier: "ACME-318", key: "plan", title: "Migration plan", body: "Phase 1." }],
  sources: [{ id: "src_1", title: "Whitepaper", url: "https://example.com/w", description: "Trends." }],
};

function writeBundle(files: Array<{ path: string; content: string }>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "okf-test-"));
  for (const file of files) {
    const dest = path.join(dir, file.path);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, file.content, "utf8");
  }
  return dir;
}

describe("okf-export buildOkfBundle", () => {
  it("emits a concept per source plus reserved files and okf.yaml", () => {
    const files = buildOkfBundle(dump);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toContain("index.md");
    expect(paths).toContain("log.md");
    expect(paths).toContain("okf.yaml");
    expect(paths).toContain("memory/deploy-window-policy.md");
    expect(paths).toContain("skills/postmortem.md");
    expect(paths).toContain("decisions/acme-318.md");
    expect(paths).toContain("docs/acme-318-plan.md");
    expect(paths).toContain("sources/whitepaper.md");
  });

  it("gives every concept a non-empty OKF `type` and maps it per section", () => {
    const files = buildOkfBundle(dump);
    const typeFor = (p: string) => parseFrontmatter(files.find((f) => f.path === p)!.content).frontmatter.type;
    expect(typeFor("memory/deploy-window-policy.md")).toBe("memory");
    expect(typeFor("skills/postmortem.md")).toBe("skill");
    expect(typeFor("decisions/acme-318.md")).toBe("decision");
    expect(typeFor("docs/acme-318-plan.md")).toBe("document");
    expect(typeFor("sources/whitepaper.md")).toBe("source");
  });

  it("declares okf_version 0.1 in bundle metadata and an ISO date in log.md", () => {
    const files = buildOkfBundle(dump);
    const meta = files.find((f) => f.path === "okf.yaml")!.content;
    expect(meta).toMatch(/okf_version:\s*"0\.1"/);
    const log = files.find((f) => f.path === "log.md")!.content;
    expect(log).toMatch(/^## 2026-06-14$/m);
  });

  it("renders decision citations and bundle-relative index links", () => {
    const files = buildOkfBundle(dump);
    const decision = files.find((f) => f.path === "decisions/acme-318.md")!.content;
    expect(decision).toContain("# Citations");
    expect(decision).toContain("resource: \"paperclip:issue:ACME-318\"");
    const index = files.find((f) => f.path === "index.md")!.content;
    expect(index).toContain("[Pick Postgres](/decisions/acme-318.md)");
  });

  it("de-duplicates colliding slugs within a section", () => {
    const files = buildOkfBundle({ skills: [{ name: "dup" }, { name: "dup" }] });
    const slugs = files.filter((f) => f.path.startsWith("skills/")).map((f) => f.path).sort();
    expect(slugs).toEqual(["skills/dup-2.md", "skills/dup.md"]);
  });
});

describe("okf-validate validateOkfBundle", () => {
  let exported: string;
  beforeAll(() => {
    exported = writeBundle(buildOkfBundle(dump));
  });
  afterAll(() => rmSync(exported, { recursive: true, force: true }));

  it("passes a freshly exported bundle with zero errors", () => {
    const report = validateOkfBundle(exported);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.conceptCount).toBe(5);
  });

  it("passes the shipped sample bundle", () => {
    const report = validateOkfBundle(sampleBundleDir);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("errors when a concept is missing a `type` field", () => {
    const dir = writeBundle([
      { path: "okf.yaml", content: 'okf_version: "0.1"\n' },
      { path: "bad.md", content: "---\ntitle: \"No type\"\n---\n\n# No type\n" },
    ]);
    try {
      const report = validateOkfBundle(dir);
      expect(report.ok).toBe(false);
      expect(report.errors.join("\n")).toMatch(/missing a non-empty 'type'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("errors when frontmatter is absent on a non-reserved file", () => {
    const dir = writeBundle([{ path: "no-fm.md", content: "# Just a body, no frontmatter\n" }]);
    try {
      const report = validateOkfBundle(dir);
      expect(report.ok).toBe(false);
      expect(report.errors.join("\n")).toMatch(/missing YAML frontmatter/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tolerates broken cross-links as warnings, not errors (per spec)", () => {
    const dir = writeBundle([
      { path: "okf.yaml", content: 'okf_version: "0.1"\n' },
      {
        path: "a.md",
        content: '---\ntype: "memory"\n---\n\n# A\n\nSee [gone](/missing/ghost.md).\n',
      },
    ]);
    try {
      const report = validateOkfBundle(dir);
      expect(report.ok).toBe(true);
      expect(report.errors).toEqual([]);
      expect(report.warnings.join("\n")).toMatch(/cross-link to missing target/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not flag external or anchor links as broken", () => {
    const dir = writeBundle([
      { path: "okf.yaml", content: 'okf_version: "0.1"\n' },
      {
        path: "a.md",
        content:
          '---\ntype: "source"\n---\n\n# A\n\n[ext](https://example.com) and [doc](paperclip:issue:ACME-1).\n',
      },
    ]);
    try {
      const report = validateOkfBundle(dir);
      expect(report.warnings.filter((w) => w.includes("cross-link"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseFrontmatter", () => {
  it("parses scalars and block sequences", () => {
    const parsed = parseFrontmatter('---\ntype: "memory"\ntags:\n  - "a"\n  - "b"\n---\n\nbody\n');
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.frontmatter.type).toBe("memory");
    expect(parsed.frontmatter.tags).toEqual(["a", "b"]);
  });

  it("reports an unclosed frontmatter block", () => {
    const parsed = parseFrontmatter('---\ntype: "memory"\n\nno closing fence\n');
    expect(parsed.error).toMatch(/not closed/);
  });
});
