import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDb, type Db } from "./client.js";
import { agents, companies, companySkills } from "./schema/index.js";
import { OREBIT_CANONICAL_ROLE_NAMES, OREBIT_DEFAULT_ORG_AGENT_NAMES } from "@paperclipai/shared";

type BootstrapTaxonomyEntry = {
  key: string;
  slug: string;
  name: string;
  description: string;
  markdown: string;
};

export type CanonicalCompanyBootstrap = {
  name: string;
  description: string;
  issuePrefix: string;
  taxonomy: BootstrapTaxonomyEntry[];
};

type OrebitRosterEntry = {
  key: string;
  name: string;
  role: string;
  title: string | null;
  icon: string | null;
  capabilities: string | null;
  reportsToKey: string | null;
  canCreateAgents: boolean;
};

type SeededCompany = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  issuePrefix: string;
  budgetMonthlyCents: number;
};

export const OREBIT_BOOTSTRAP_COMPANY: CanonicalCompanyBootstrap = {
  name: "Orebit",
  description:
    "Orebit builds practical AI and data workflows for mining and geoscience teams, combining domain expertise, transparent pipelines, and productized tooling to turn geological complexity into reliable, affordable, decision-ready intelligence.",
  issuePrefix: "ORE",
  taxonomy: [
    {
      key: "taxonomy/geology",
      slug: "geology",
      name: "Geology",
      description: "Open-source geology problems and practical, inspectable tools.",
      markdown: "# Geology\n\nOrebit exists to help solve open-source geology problems with reliable, low-price digital tools.",
    },
    {
      key: "taxonomy/ai",
      slug: "ai",
      name: "AI",
      description: "Applied AI workflows for mining and geoscience teams.",
      markdown: "# AI\n\nOrebit uses applied AI to support domain workflows, not generic chat-only experiences.",
    },
    {
      key: "taxonomy/geostatistics",
      slug: "geostatistics",
      name: "Geostatistics",
      description: "Statistical workflows for technical, decision-ready geological analysis.",
      markdown: "# Geostatistics\n\nOrebit pairs domain expertise with statistical workflows that stay inspectable and practical.",
    },
    {
      key: "taxonomy/saas",
      slug: "saas",
      name: "SaaS",
      description: "Productized deployments and premium implementation support.",
      markdown: "# SaaS\n\nOrebit turns its domain expertise into deployable software products and services.",
    },
    {
      key: "taxonomy/research",
      slug: "research",
      name: "Research",
      description: "Applied research interfaces grounded in evidence and workflows.",
      markdown: "# Research\n\nOrebit keeps research useful by grounding it in practitioner workflows and inspectable evidence.",
    },
    {
      key: "taxonomy/ops",
      slug: "ops",
      name: "Ops",
      description: "Operational workflows, monitoring, and reliability for the company stack.",
      markdown: "# Ops\n\nOrebit runs on explicit operations, monitoring, and fail-closed execution.",
    },
  ],
};

const OREBIT_BOOTSTRAP_ROSTER: OrebitRosterEntry[] = [
  {
    key: "ceo",
    name: OREBIT_CANONICAL_ROLE_NAMES.ceo,
    role: "ceo",
    title: "CEO",
    icon: "crown",
    capabilities: "Owns company strategy and coordination.",
    reportsToKey: null,
    canCreateAgents: true,
  },
  {
    key: "cto",
    name: OREBIT_CANONICAL_ROLE_NAMES.cto,
    role: "cto",
    title: "CTO",
    icon: "cpu",
    capabilities: "Owns technical execution and systems reliability.",
    reportsToKey: "ceo",
    canCreateAgents: false,
  },
  {
    key: "cmo",
    name: OREBIT_CANONICAL_ROLE_NAMES.cmo,
    role: "cmo",
    title: "CMO",
    icon: "mail",
    capabilities: "Owns marketing and external communication.",
    reportsToKey: "ceo",
    canCreateAgents: false,
  },
  ...OREBIT_DEFAULT_ORG_AGENT_NAMES.map((name, index) => ({
    key: `org-${index + 1}`,
    name,
    role: "general",
    title: null,
    icon: "bot",
    capabilities: "Canonical Orebit org roster member.",
    reportsToKey: "ceo",
    canCreateAgents: false,
  })),
];

function buildStableUuid(value: string) {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20, 32).join("")}`;
}

function buildOrebitRosterAgentId(companyId: string, rosterKey: string) {
  return buildStableUuid(`orebit-roster:${companyId}:${rosterKey}`);
}

export async function seedCanonicalOrebitRoster(db: Pick<Db, "insert">, companyId: string) {
  const rosterIds = new Map<string, string>();

  for (const entry of OREBIT_BOOTSTRAP_ROSTER) {
    const id = buildOrebitRosterAgentId(companyId, entry.key);
    rosterIds.set(entry.key, id);
    const reportsTo = entry.reportsToKey ? rosterIds.get(entry.reportsToKey) ?? buildOrebitRosterAgentId(companyId, entry.reportsToKey) : null;
    const now = new Date();
    const values = {
      id,
      companyId,
      name: entry.name,
      role: entry.role,
      title: entry.title,
      icon: entry.icon,
      status: "idle" as const,
      reportsTo,
      capabilities: entry.capabilities,
      adapterType: "codex_local",
      adapterConfig: {
        cwd: process.cwd(),
      },
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      permissions: { canCreateAgents: entry.canCreateAgents },
      pauseReason: null,
      pausedAt: null,
      lastHeartbeatAt: null,
      metadata: {
        canonicalRoster: true,
        orebitBootstrap: true,
        rosterKey: entry.key,
      },
      updatedAt: now,
    };

    await db.insert(agents).values(values).onConflictDoUpdate({
      target: agents.id,
      set: values,
    }).returning();
  }
}

function validateCanonicalCompanyBootstrap(input: CanonicalCompanyBootstrap) {
  const missing: string[] = [];

  if (typeof input.name !== "string" || input.name.trim().length === 0) missing.push("name");
  if (typeof input.description !== "string" || input.description.trim().length === 0) missing.push("description");
  if (typeof input.issuePrefix !== "string" || input.issuePrefix.trim().length === 0) missing.push("issuePrefix");
  if (!Array.isArray(input.taxonomy) || input.taxonomy.length === 0) missing.push("taxonomy");

  const invalidTaxonomy = Array.isArray(input.taxonomy)
    ? input.taxonomy.find((entry) =>
      typeof entry.key !== "string" || entry.key.trim().length === 0
      || typeof entry.slug !== "string" || entry.slug.trim().length === 0
      || typeof entry.name !== "string" || entry.name.trim().length === 0
      || typeof entry.description !== "string" || entry.description.trim().length === 0
      || typeof entry.markdown !== "string" || entry.markdown.trim().length === 0,
    )
    : null;

  if (invalidTaxonomy) {
    throw new Error("Bootstrap company identity is required: each taxonomy entry must include key, slug, name, description, and markdown.");
  }

  if (missing.length > 0) {
    throw new Error(`Bootstrap company identity is required: missing ${missing.join(", ")}.`);
  }
}

export async function seedCanonicalOrebitCompany(
  db: Pick<Db, "insert">,
  bootstrap: CanonicalCompanyBootstrap = OREBIT_BOOTSTRAP_COMPANY,
): Promise<{ company: SeededCompany; taxonomy: BootstrapTaxonomyEntry[] }> {
  validateCanonicalCompanyBootstrap(bootstrap);

  const [company] = await db
    .insert(companies)
    .values({
      name: bootstrap.name,
      description: bootstrap.description,
      status: "active",
      issuePrefix: bootstrap.issuePrefix,
      budgetMonthlyCents: 0,
    })
    .onConflictDoUpdate({
      target: companies.issuePrefix,
      set: {
        name: bootstrap.name,
        description: bootstrap.description,
        status: "active",
        issuePrefix: bootstrap.issuePrefix,
        budgetMonthlyCents: 0,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!company) {
    throw new Error("Failed to seed canonical Orebit company.");
  }

  const taxonomyRecords = bootstrap.taxonomy.map((entry) => ({
    companyId: company.id,
    key: entry.key,
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
    markdown: entry.markdown,
    sourceType: "catalog" as const,
    sourceLocator: null,
    sourceRef: "orebit-bootstrap",
    trustLevel: "markdown_only" as const,
    compatibility: "compatible" as const,
    fileInventory: [],
    metadata: {
      canonical: true,
      taxonomy: true,
    },
  }));

  for (const entry of taxonomyRecords) {
    const [taxonomy] = await db
      .insert(companySkills)
      .values(entry)
      .onConflictDoUpdate({
        target: [companySkills.companyId, companySkills.key],
        set: {
          slug: entry.slug,
          name: entry.name,
          description: entry.description,
          markdown: entry.markdown,
          sourceType: "catalog",
          sourceLocator: null,
          sourceRef: "orebit-bootstrap",
          trustLevel: "markdown_only",
          compatibility: "compatible",
          fileInventory: [],
          metadata: {
            canonical: true,
            taxonomy: true,
          },
        },
      })
      .returning();

    if (!taxonomy) {
      throw new Error("Failed to seed canonical Orebit company taxonomy.");
    }
  }

  await seedCanonicalOrebitRoster(db, company.id);

  return { company, taxonomy: taxonomyRecords };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const db = createDb(url);
  console.log("Seeding canonical Orebit company and roster...");
  await seedCanonicalOrebitCompany(db);
  console.log("Seed complete");
}

const isMainModule = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
