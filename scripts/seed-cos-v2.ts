#!/usr/bin/env -S node --import tsx
/**
 * COS v2 seed script — creates teams, sub-teams, leader agents, sub-agents.
 *
 * Usage:
 *   pnpm tsx scripts/seed-cos-v2.ts [--port 3101] [--company-id <id>]
 *
 * Idempotent: skips entities that already exist by name/identifier.
 */

const args = process.argv.slice(2);
const port = (() => {
  const i = args.indexOf("--port");
  return i >= 0 ? Number(args[i + 1]) : 3101;
})();
const companyIdArg = (() => {
  const i = args.indexOf("--company-id");
  return i >= 0 ? args[i + 1] : null;
})();

const baseUrl = `http://127.0.0.1:${port}/api`;

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 409) {
    const text = await res.text();
    throw new Error(`${method} ${path} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

interface Company { id: string; name: string }
interface Team { id: string; name: string; identifier: string; parentId: string | null }
interface Agent { id: string; name: string }

async function getOrCreateCompany(): Promise<Company> {
  if (companyIdArg) {
    const company = await api<Company>("GET", `/companies/${companyIdArg}`);
    return company;
  }
  const companies = await api<Company[]>("GET", "/companies/");
  if (companies.length > 0) return companies[0];
  return await api<Company>("POST", "/companies/", { name: "BBrightcode Corp" });
}

async function getOrCreateTeam(
  companyId: string,
  spec: { name: string; identifier: string; parentId?: string | null; color?: string },
): Promise<Team> {
  const teams = await api<Team[]>("GET", `/companies/${companyId}/teams`);
  const existing = teams.find((t) => t.identifier === spec.identifier);
  if (existing) {
    console.log(`  ↺ team ${spec.identifier} already exists (${existing.id.slice(0, 8)})`);
    return existing;
  }
  const team = await api<Team>("POST", `/companies/${companyId}/teams`, {
    name: spec.name,
    identifier: spec.identifier,
    parentId: spec.parentId ?? null,
    color: spec.color ?? null,
  });
  console.log(`  + team ${spec.identifier}: ${spec.name}`);
  return team;
}

async function getOrCreateAgent(
  companyId: string,
  spec: {
    name: string;
    role?: string;
    title?: string;
    adapterType?: string;
    capabilities?: string;
  },
): Promise<Agent> {
  const agents = await api<Agent[]>("GET", `/companies/${companyId}/agents`);
  const existing = agents.find((a) => a.name === spec.name);
  if (existing) {
    console.log(`  ↺ agent ${spec.name} already exists`);
    return existing;
  }
  const agent = await api<Agent>("POST", `/companies/${companyId}/agents`, {
    name: spec.name,
    role: spec.role ?? "general",
    title: spec.title ?? null,
    adapterType: spec.adapterType ?? "claude_local",
    capabilities: spec.capabilities ?? null,
  });
  console.log(`  + agent ${spec.name} (${spec.adapterType ?? "claude_local"})`);
  return agent;
}

async function addTeamMember(
  companyId: string,
  teamId: string,
  agentId: string,
  role: "lead" | "member",
): Promise<void> {
  const res = await fetch(`${baseUrl}/companies/${companyId}/teams/${teamId}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, role }),
  });
  if (res.status === 201) {
    console.log(`    + member ${agentId.slice(0, 8)} as ${role}`);
  } else if (res.status === 409) {
    console.log(`    ↺ member ${agentId.slice(0, 8)} already in team`);
  } else {
    const text = await res.text();
    throw new Error(`add member failed: ${res.status} ${text}`);
  }
}

async function setTeamLead(companyId: string, teamId: string, leadAgentId: string) {
  await api<Team>("PATCH", `/companies/${companyId}/teams/${teamId}`, { leadAgentId });
}

async function main() {
  console.log("=== COS v2 seed ===");

  const company = await getOrCreateCompany();
  console.log(`Company: ${company.name} (${company.id})`);

  // 1) Top-level teams
  console.log("\n1. Creating top-level teams");
  const osTeam = await getOrCreateTeam(company.id, {
    name: "OS",
    identifier: "COM",
    color: "#0EA5E9",
  });
  const flotterTeam = await getOrCreateTeam(company.id, {
    name: "Flotter",
    identifier: "FLT",
    color: "#8B5CF6",
  });
  const sbTeam = await getOrCreateTeam(company.id, {
    name: "Superbuilder",
    identifier: "SB",
    color: "#10B981",
  });

  // 2) Flotter sub-teams
  console.log("\n2. Creating Flotter sub-teams");
  const engTeam = await getOrCreateTeam(company.id, {
    name: "Engine",
    identifier: "ENG3",
    parentId: flotterTeam.id,
    color: "#3B82F6",
  });
  const pltTeam = await getOrCreateTeam(company.id, {
    name: "Platform",
    identifier: "PLT3",
    parentId: flotterTeam.id,
    color: "#A855F7",
  });
  const grwTeam = await getOrCreateTeam(company.id, {
    name: "Growth",
    identifier: "GRW",
    parentId: flotterTeam.id,
    color: "#F59E0B",
  });
  const qaTeam = await getOrCreateTeam(company.id, {
    name: "QA",
    identifier: "QA",
    parentId: flotterTeam.id,
    color: "#EF4444",
  });

  // 3) Leader agents (claude_local)
  console.log("\n3. Creating leader agents");
  const sophia = await getOrCreateAgent(company.id, { name: "Sophia", title: "OS Lead", adapterType: "claude_local" });
  const hana = await getOrCreateAgent(company.id, { name: "Hana", title: "Flotter CoS", adapterType: "claude_local" });
  const cyrus = await getOrCreateAgent(company.id, { name: "Cyrus", title: "Engine Lead", adapterType: "claude_local" });
  const felix = await getOrCreateAgent(company.id, { name: "Felix", title: "Platform Lead", adapterType: "claude_local" });
  const lunaLead = await getOrCreateAgent(company.id, { name: "LunaLead", title: "Growth Lead", adapterType: "claude_local" });
  const iris = await getOrCreateAgent(company.id, { name: "Iris", title: "QA Lead", adapterType: "claude_local" });
  const rex = await getOrCreateAgent(company.id, { name: "Rex", title: "SB Lead", adapterType: "claude_local" });

  // 4) Sub agents (none adapter)
  console.log("\n4. Creating sub-agents");
  const orion = await getOrCreateAgent(company.id, {
    name: "Orion",
    title: "Architect",
    adapterType: "process",
    capabilities: "system design, architecture review",
  });
  const kai = await getOrCreateAgent(company.id, {
    name: "Kai",
    title: "Programmer",
    adapterType: "process",
    capabilities: "implementation, coding, debugging",
  });
  const lux = await getOrCreateAgent(company.id, {
    name: "Lux",
    title: "Renderer",
    adapterType: "process",
    capabilities: "WebGL/Canvas rendering",
  });
  const vera = await getOrCreateAgent(company.id, {
    name: "Vera",
    title: "QA Engineer",
    adapterType: "process",
    capabilities: "test writing, quality verification",
  });
  const yuna = await getOrCreateAgent(company.id, {
    name: "Yuna",
    title: "UX Designer",
    adapterType: "process",
    capabilities: "UX design, user research",
  });
  const jett = await getOrCreateAgent(company.id, {
    name: "Jett",
    title: "Platform Engineer",
    adapterType: "process",
    capabilities: "platform engineering, infrastructure",
  });
  const nova = await getOrCreateAgent(company.id, {
    name: "Nova",
    title: "AI Engineer",
    adapterType: "process",
    capabilities: "AI/ML engineering, prompt design",
  });
  const remy = await getOrCreateAgent(company.id, {
    name: "Remy",
    title: "Code Reviewer",
    adapterType: "process",
    capabilities: "code review, refactoring",
  });
  const zion = await getOrCreateAgent(company.id, {
    name: "Zion",
    title: "UI Tester",
    adapterType: "process",
    capabilities: "UI testing, visual QA",
  });
  const blitz = await getOrCreateAgent(company.id, {
    name: "Blitz",
    title: "Performance Engineer",
    adapterType: "process",
    capabilities: "performance, benchmarking",
  });
  const aria = await getOrCreateAgent(company.id, {
    name: "Aria",
    title: "Community Manager",
    adapterType: "process",
    capabilities: "community management, communication",
  });

  // 5) Team membership + leads
  console.log("\n5. Assigning team memberships");
  console.log(`  ${osTeam.identifier}:`);
  await setTeamLead(company.id, osTeam.id, sophia.id);
  console.log(`  ${flotterTeam.identifier}:`);
  await setTeamLead(company.id, flotterTeam.id, hana.id);
  console.log(`  ${engTeam.identifier}:`);
  await setTeamLead(company.id, engTeam.id, cyrus.id);
  await addTeamMember(company.id, engTeam.id, orion.id, "member");
  await addTeamMember(company.id, engTeam.id, kai.id, "member");
  await addTeamMember(company.id, engTeam.id, lux.id, "member");
  await addTeamMember(company.id, engTeam.id, vera.id, "member");
  console.log(`  ${pltTeam.identifier}:`);
  await setTeamLead(company.id, pltTeam.id, felix.id);
  await addTeamMember(company.id, pltTeam.id, yuna.id, "member");
  await addTeamMember(company.id, pltTeam.id, jett.id, "member");
  await addTeamMember(company.id, pltTeam.id, nova.id, "member");
  console.log(`  ${grwTeam.identifier}:`);
  await setTeamLead(company.id, grwTeam.id, lunaLead.id);
  await addTeamMember(company.id, grwTeam.id, aria.id, "member");
  console.log(`  ${qaTeam.identifier}:`);
  await setTeamLead(company.id, qaTeam.id, iris.id);
  await addTeamMember(company.id, qaTeam.id, remy.id, "member");
  await addTeamMember(company.id, qaTeam.id, zion.id, "member");
  await addTeamMember(company.id, qaTeam.id, blitz.id, "member");
  console.log(`  ${sbTeam.identifier}:`);
  await setTeamLead(company.id, sbTeam.id, rex.id);

  console.log("\n✓ Seed complete");
}

main().catch((err) => {
  console.error("✗ Seed failed:", err);
  process.exit(1);
});
