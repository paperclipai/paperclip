import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';

// postgres is not hoisted to root node_modules by pnpm;
// resolve it from @paperclipai/db which declares it as a dependency.
const _require = createRequire(
  path.join(process.cwd(), 'packages', 'db', 'src', 'client.ts')
);
const postgres = _require('postgres') as typeof import('postgres').default;

const sql = postgres('postgres://paperclip:paperclip@127.0.0.1:54329/paperclip');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOME = os.homedir();
const OPENCLAW_DIR = path.join(HOME, '.openclaw');

const CHEMDRY_COMPANY_ID = '7ab11f25-a87c-4b1e-8996-4c217d9c1dd0';
const AUTOMAGIC_COMPANY_ID = 'f6a8cf89-2df0-400d-aa91-c94339e7aaec';

const CHEMDRY_AGENTS_DIR = path.join(HOME, 'chemdry', 'agent-org', 'agents');
const AUTOMAGIC_AGENTS_DIR = path.join(HOME, 'automagic', 'agent-org', 'agents');
const PERSONAL_AGENTS_DIR = path.join(HOME, 'personal', 'agent-org', 'agents');

// Existing Chem-Dry agent IDs
const CHEMDRY_MAVEN_ID = '65a5cfaf-bd02-4920-a425-09859c16ac43';
const CHEMDRY_BEACON_ID = '3789f377-7b9b-43e6-88d3-99e276556f17';
const CHEMDRY_LENS_ID = '75cd7bfc-6997-4dee-9528-28c753936f68';
const CHEMDRY_SENTINEL_ID = 'cddc9ef2-db0e-4053-a58d-908901d5cce3';
const CHEMDRY_MARSHALL_ID = '1e0bd5e3-68a9-4998-b117-53cc3950cde4';

// Automagic Slate (CEO)
const AUTOMAGIC_SLATE_ID = '76b6feb2-1f84-408f-a576-9e98e640cdf5';

// Default adapter / runtime configs for new agents
const DEFAULT_ADAPTER_CONFIG = {
  command: 'claude',
  model: 'claude-sonnet-4-6',
  maxTurnsPerRun: 80,
  timeoutSec: 0,
  graceSec: 15,
};

const DEFAULT_RUNTIME_CONFIG = {
  heartbeat: {
    intervalSec: 3600,
    cooldownSec: 10,
    wakeOnAssignment: true,
    wakeOnDemand: true,
    maxConcurrentRuns: 3,
  },
};

// ---------------------------------------------------------------------------
// Merge mappings: Chem-Dry existing agents <- OpenClaw workspaces
// ---------------------------------------------------------------------------

const CHEMDRY_MERGE_MAP: Array<{
  agentId: string;
  agentName: string;
  openclawWorkspace: string;
  /** Subdirectory under the agent-org/agents/ tree where the Paperclip SOUL.md lives.
   *  Some agents have cwd pointing to the shared agent-org root rather than their own subdir. */
  paperclipSubdir: string;
  title: string;
  isManager: boolean;
}> = [
  { agentId: CHEMDRY_MAVEN_ID, agentName: 'Maven', openclawWorkspace: 'workspace-maven', paperclipSubdir: 'cmo', title: 'CMO', isManager: true },
  { agentId: CHEMDRY_BEACON_ID, agentName: 'Beacon', openclawWorkspace: 'workspace-local-seo', paperclipSubdir: 'seo-sem-specialist', title: 'SEO/SEM Specialist', isManager: false },
  { agentId: CHEMDRY_LENS_ID, agentName: 'Lens', openclawWorkspace: 'workspace-analytics', paperclipSubdir: 'performance-analyst', title: 'Performance Analyst', isManager: false },
  { agentId: CHEMDRY_SENTINEL_ID, agentName: 'Sentinel', openclawWorkspace: 'workspace-clawbot', paperclipSubdir: 'platform-ops', title: 'Platform Operations Manager', isManager: true },
  { agentId: CHEMDRY_MARSHALL_ID, agentName: 'Marshall', openclawWorkspace: 'workspace-orchestrator', paperclipSubdir: 'ceo', title: 'CEO', isManager: true },
];

// ---------------------------------------------------------------------------
// New Chem-Dry agents to create
// ---------------------------------------------------------------------------

const CHEMDRY_NEW_AGENTS: Array<{
  name: string;
  slug: string;
  role: string;
  title: string;
  reportsTo: string;
  icon: string;
  openclawWorkspace: string;
  isManager: boolean;
}> = [
  { name: 'Echo', slug: 'review-manager', role: 'marketing', title: 'Review Manager', reportsTo: CHEMDRY_MAVEN_ID, icon: 'star', openclawWorkspace: 'workspace-review', isManager: false },
  { name: 'Prism', slug: 'offer-optimization', role: 'marketing', title: 'Offer Optimization', reportsTo: CHEMDRY_MAVEN_ID, icon: 'flask', openclawWorkspace: 'workspace-offer-opt', isManager: false },
  { name: 'Spark', slug: 'ad-creative', role: 'marketing', title: 'Ad Creative Producer', reportsTo: CHEMDRY_MAVEN_ID, icon: 'sparkles', openclawWorkspace: 'workspace-ad-creative', isManager: false },
];

// ---------------------------------------------------------------------------
// Automagic marketing team definitions
// ---------------------------------------------------------------------------

interface AutomagicAgentDef {
  name: string;
  slug: string;
  role: string;
  title: string;
  icon: string;
  openclawWorkspace: string;
  reportsToSlug: string | null; // null = reports to Slate, 'cmo' = reports to automagic Maven
  isManager: boolean;
}

const AUTOMAGIC_AGENTS: AutomagicAgentDef[] = [
  { name: 'Maven', slug: 'cmo', role: 'marketing', title: 'CMO', icon: 'trending-up', openclawWorkspace: 'workspace-maven', reportsToSlug: null, isManager: true },
  { name: 'Beacon', slug: 'seo-sem', role: 'marketing', title: 'SEO/SEM Specialist', icon: 'map-pin', openclawWorkspace: 'workspace-local-seo', reportsToSlug: 'cmo', isManager: false },
  { name: 'Lens', slug: 'analytics', role: 'marketing', title: 'Performance Analyst', icon: 'bar-chart', openclawWorkspace: 'workspace-analytics', reportsToSlug: 'cmo', isManager: false },
  { name: 'Echo', slug: 'review-manager', role: 'marketing', title: 'Review Manager', icon: 'star', openclawWorkspace: 'workspace-review', reportsToSlug: 'cmo', isManager: false },
  { name: 'Prism', slug: 'offer-optimization', role: 'marketing', title: 'Offer Optimization', icon: 'flask', openclawWorkspace: 'workspace-offer-opt', reportsToSlug: 'cmo', isManager: false },
  { name: 'Spark', slug: 'ad-creative', role: 'marketing', title: 'Ad Creative Producer', icon: 'sparkles', openclawWorkspace: 'workspace-ad-creative', reportsToSlug: 'cmo', isManager: false },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function adaptSoulForPaperclip(content: string, brandContext: string): string {
  let adapted = content;
  // Remove OpenClaw-specific references
  adapted = adapted.replace(/OpenClaw/gi, 'Paperclip');
  adapted = adapted.replace(/openclaw/gi, 'paperclip');
  adapted = adapted.replace(/~\/\.openclaw\//g, '');
  adapted = adapted.replace(/the OpenClaw AI growth system/gi, `the ${brandContext} organization`);
  adapted = adapted.replace(/the Paperclip AI growth system/gi, `the ${brandContext} organization`);
  // Remove HTML comments
  adapted = adapted.replace(/<!--.*?-->/gs, '');
  return adapted.trim();
}

function adaptSoulForAutomagic(content: string): string {
  let adapted = adaptSoulForPaperclip(content, 'Automagic AI');
  adapted = adapted.replace(/Chem-Dry/gi, 'Automagic AI');
  adapted = adapted.replace(/chemdry/gi, 'automagic');
  adapted = adapted.replace(/3-location.*?franchise/gi, 'Automagic AI company');
  return adapted.trim();
}

function adaptSoulForChemdry(content: string): string {
  return adaptSoulForPaperclip(content, 'Chem-Dry');
}

// ---------------------------------------------------------------------------
// AGENTS.md generation
// ---------------------------------------------------------------------------

function generateAgentsMd(opts: {
  agentName: string;
  title: string;
  companyName: string;
  isManager: boolean;
  userMdPath?: string;
}): string {
  const { agentName, title, companyName, isManager, userMdPath } = opts;

  const schedulingSection = isManager
    ? `
## Scheduling

You can use the \`cron-scheduling\` skill to create, update, and manage recurring scheduled tasks for yourself and your direct reports. Use it when you need agents to perform work on a time-based schedule (e.g., daily analytics pulls, weekly performance reviews, business-hours monitoring).
`
    : '';

  const managerGatekeep = isManager
    ? `
### Manager Responsibility: Gatekeep Escalations

When a report escalates to you, check their work before passing it up:
- Did they try 3+ approaches? If not, send it back with a comment telling them what to try.
- Is this a real blocker (credentials, permissions, human action) or a soft dependency (information they could find)? Only escalate real blockers to the CEO.
- Never forward a report's escalation verbatim. Add your own analysis and recommendation.
`
    : '';

  const userMdRef = userMdPath
    ? `\n- \`${userMdPath}\` -- board member context (owner profile, communication preferences, businesses)`
    : '';

  return `You are ${agentName}, the ${title} at ${companyName}.

Your home directory is $AGENT_HOME. Everything personal to you -- life, memory, knowledge -- lives there. Other agents may have their own folders and you may update them when necessary.

Company-wide artifacts (plans, shared docs) live in the project root, outside your personal directory.

## Memory and Planning

You MUST use the \`para-memory-files\` skill for all memory operations: storing facts, writing daily notes, creating entities, running weekly synthesis, recalling past context, and managing plans. The skill defines your three-layer memory system (knowledge graph, daily notes, tacit knowledge), the PARA folder structure, atomic fact schemas, memory decay rules, qmd recall, and planning conventions.

Invoke it whenever you need to remember, retrieve, or organize anything.
${schedulingSection}
## Autonomy & Self-Sufficiency

You are responsible for end-to-end task completion. Minimize escalations. The board should only hear from you when you are truly stuck -- not when you haven't tried hard enough.

### What "Blocked" Actually Means

You are **blocked** only when you lack:
- Credentials or API keys you cannot generate yourself
- Permissions to a system you have no access to
- Authorization for a spend or hire decision above your level
- A physical action only a human can perform (e.g., signing a document)

You are **NOT blocked** when:
- You can't find information -- search harder (memory, web, browser, file system)
- A tool call failed -- try a different tool or approach
- You don't know how to do something -- research it
- You need context about the business -- check MEMORY.md, USER.md, issue history, or use web search

### Pre-Escalation Checklist (Rule of Three)

Before marking any task as \`blocked\` or asking your manager for help, you MUST:

1. **Check memory first.** Search your \`MEMORY.md\`, daily notes, and entity files. The answer may already be there.
2. **Try three different approaches.** Use different tool combinations, search queries, or strategies. Document each attempt in your daily notes.
3. **Use your browser.** You have Chrome automation. If you need data from a website, try navigating there and pulling it yourself before asking someone to export it.
4. **Search the web.** For domain knowledge, competitor info, best practices, or technical how-tos, use web search before asking.
5. **Check issue history.** Read parent issues, sibling issues, and comment threads. Context you need is often already documented by another agent.
6. **Write a failure analysis.** In your daily notes, write what you tried, why it failed, and why you believe only an external action can unblock you. This step often triggers a new idea.

Only after completing all six steps should you escalate. When you do escalate, your comment MUST include:
- What you tried (at least 3 approaches)
- Why each failed
- What specific external action you need (not "I need help" -- be exact)

### Independence Contract

- Do not ask for a file's contents if you can read it yourself.
- Do not ask for a summary if you have access to the source.
- Do not ask what tools you have -- check your TOOLS.md and discover what's available.
- Do not ask for business context that exists in USER.md or MEMORY.md.
- Do not report a tool as "unavailable" without trying at least two alternative tools or approaches.
${managerGatekeep}
## Safety Considerations

- Never exfiltrate secrets or private data.
- Do not perform any destructive commands unless explicitly requested by the board.

## References

These files are essential. Read them.

- \`$AGENT_HOME/HEARTBEAT.md\` -- execution and extraction checklist. Run every heartbeat.
- \`$AGENT_HOME/SOUL.md\` -- who you are and how you should act.
- \`$AGENT_HOME/TOOLS.md\` -- tools you have access to${userMdRef}
`;
}

function fixPathReferences(content: string): string {
  return content
    .replace(/~\/\.openclaw\//g, '~/')
    .replace(/\/Users\/[^/]+\/\.openclaw\//g, '~/');
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  if (!(await dirExists(src))) return;
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else {
      let content = await fs.readFile(srcPath, 'utf-8');
      content = fixPathReferences(content);
      await fs.writeFile(destPath, content, 'utf-8');
    }
  }
}

// ---------------------------------------------------------------------------
// Step 1: Read OpenClaw configs
// ---------------------------------------------------------------------------

async function readOpenClawConfigs() {
  console.log('\n=== Step 1: Reading OpenClaw configs ===');

  const openclawJsonPath = path.join(OPENCLAW_DIR, 'openclaw.json');
  const registryPath = path.join(OPENCLAW_DIR, 'shared', 'agents-registry.json');

  const openclawJson = await readFileIfExists(openclawJsonPath);
  if (!openclawJson) {
    throw new Error(`Cannot read ${openclawJsonPath}`);
  }
  console.log(`  Read openclaw.json (${openclawJson.length} chars)`);

  const registryJson = await readFileIfExists(registryPath);
  if (!registryJson) {
    throw new Error(`Cannot read ${registryPath}`);
  }
  const registry = JSON.parse(registryJson);
  console.log(`  Read agents-registry.json (${registry.agents?.length ?? 0} agents, ${registry.planned?.length ?? 0} planned)`);

  return { openclawConfig: JSON.parse(openclawJson), registry };
}

// ---------------------------------------------------------------------------
// Step 2: Get existing Paperclip state
// ---------------------------------------------------------------------------

interface DbAgent {
  id: string;
  company_id: string;
  name: string;
  role: string;
  title: string | null;
  status: string;
  reports_to: string | null;
  adapter_type: string;
  adapter_config: Record<string, unknown>;
  runtime_config: Record<string, unknown>;
  icon: string | null;
}

async function getExistingState() {
  console.log('\n=== Step 2: Querying existing Paperclip state ===');

  const companies = await sql`
    SELECT id, name FROM companies WHERE id IN (${CHEMDRY_COMPANY_ID}, ${AUTOMAGIC_COMPANY_ID})
  `;
  for (const c of companies) {
    console.log(`  Company: ${c.name} (${c.id})`);
  }

  const agents = await sql<DbAgent[]>`
    SELECT id, company_id, name, role, title, status, reports_to, adapter_type, adapter_config, runtime_config, icon
    FROM agents
    WHERE company_id IN (${CHEMDRY_COMPANY_ID}, ${AUTOMAGIC_COMPANY_ID})
    ORDER BY company_id, name
  `;
  console.log(`  Found ${agents.length} existing agents across both companies`);
  for (const a of agents) {
    console.log(`    - ${a.name} (${a.id}) [${a.company_id === CHEMDRY_COMPANY_ID ? 'Chem-Dry' : 'Automagic'}]`);
  }

  return { companies, agents };
}

// ---------------------------------------------------------------------------
// Step 3: Merge SOUL.md for existing Chem-Dry agents
// ---------------------------------------------------------------------------

async function mergeSoulFiles(agents: DbAgent[]) {
  console.log('\n=== Step 3: Merging SOUL.md for existing Chem-Dry agents ===');

  for (const mapping of CHEMDRY_MERGE_MAP) {
    const agent = agents.find(a => a.id === mapping.agentId);
    if (!agent) {
      console.log(`  SKIP: Agent ${mapping.agentName} (${mapping.agentId}) not found in DB`);
      continue;
    }

    // Resolve the actual SOUL.md location.
    // Most Chem-Dry agents share a cwd at agent-org root; the per-agent SOUL.md
    // is in agents/<subdir>/SOUL.md relative to the org root.
    const cwd = (agent.adapter_config as Record<string, unknown>)?.cwd as string | undefined;
    let soulPath: string;
    if (mapping.paperclipSubdir) {
      // Use the known subdirectory under the Chem-Dry agents tree
      soulPath = path.join(CHEMDRY_AGENTS_DIR, mapping.paperclipSubdir, 'SOUL.md');
    } else if (cwd) {
      soulPath = path.join(cwd, 'SOUL.md');
    } else {
      console.log(`  SKIP: Agent ${mapping.agentName} has no cwd in adapter_config`);
      continue;
    }
    const existingSoul = await readFileIfExists(soulPath);
    if (!existingSoul) {
      console.log(`  SKIP: No SOUL.md at ${soulPath}`);
      continue;
    }

    // Check idempotency
    if (existingSoul.includes('## OpenClaw Domain Knowledge (Migrated)')) {
      console.log(`  SKIP: ${mapping.agentName} SOUL.md already has OpenClaw section`);
      continue;
    }

    // Read OpenClaw SOUL.md
    const openclawSoulPath = path.join(OPENCLAW_DIR, mapping.openclawWorkspace, 'SOUL.md');
    const openclawSoul = await readFileIfExists(openclawSoulPath);
    if (!openclawSoul) {
      console.log(`  SKIP: No OpenClaw SOUL.md at ${openclawSoulPath}`);
      continue;
    }

    const adaptedContent = adaptSoulForChemdry(openclawSoul);
    const merged = `${existingSoul.trimEnd()}

---
## OpenClaw Domain Knowledge (Migrated)

${adaptedContent}
`;

    await fs.writeFile(soulPath, merged, 'utf-8');
    console.log(`  MERGED: ${mapping.agentName} SOUL.md at ${soulPath}`);
  }

  // Generate AGENTS.md for existing Chem-Dry agents if missing
  for (const mapping of CHEMDRY_MERGE_MAP) {
    const agentDir = path.join(CHEMDRY_AGENTS_DIR, mapping.paperclipSubdir);
    const agentsMdPath = path.join(agentDir, 'AGENTS.md');
    if (await fileExists(agentsMdPath)) {
      console.log(`  SKIP: AGENTS.md already exists at ${agentsMdPath}`);
      continue;
    }
    const content = generateAgentsMd({
      agentName: mapping.agentName,
      title: mapping.title,
      companyName: 'Chem-Dry',
      isManager: mapping.isManager,
      userMdPath: '/Users/aidenhdee/paperclip/USER.md',
    });
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(agentsMdPath, content, 'utf-8');
    console.log(`  WROTE: AGENTS.md for ${mapping.agentName} at ${agentsMdPath}`);
  }
}

// ---------------------------------------------------------------------------
// Step 4: Create new Chem-Dry agents
// ---------------------------------------------------------------------------

async function createChemdryNewAgents(existingAgents: DbAgent[]) {
  console.log('\n=== Step 4: Creating new Chem-Dry agents ===');

  for (const def of CHEMDRY_NEW_AGENTS) {
    // Idempotency: check if agent already exists
    const existing = existingAgents.find(
      a => a.name === def.name && a.company_id === CHEMDRY_COMPANY_ID
    );
    if (existing) {
      console.log(`  SKIP: ${def.name} already exists in Chem-Dry (${existing.id})`);
      continue;
    }

    const agentId = randomUUID();
    const workspaceDir = path.join(CHEMDRY_AGENTS_DIR, def.slug);
    const adapterConfig = { ...DEFAULT_ADAPTER_CONFIG, cwd: workspaceDir };

    // Create workspace directory
    await fs.mkdir(workspaceDir, { recursive: true });

    // Write SOUL.md from OpenClaw content
    const openclawSoulPath = path.join(OPENCLAW_DIR, def.openclawWorkspace, 'SOUL.md');
    const openclawSoul = await readFileIfExists(openclawSoulPath);
    let soulContent: string;
    if (openclawSoul) {
      soulContent = adaptSoulForChemdry(openclawSoul);
    } else {
      soulContent = `# ${def.name}\n\nYou are ${def.name}, the ${def.title} at Chem-Dry.\n`;
    }

    const soulPath = path.join(workspaceDir, 'SOUL.md');
    if (!(await fileExists(soulPath))) {
      await fs.writeFile(soulPath, soulContent, 'utf-8');
      console.log(`  WROTE: ${soulPath}`);
    } else {
      console.log(`  SKIP: SOUL.md already exists at ${soulPath}`);
    }

    // Write AGENTS.md
    const agentsMdPath = path.join(workspaceDir, 'AGENTS.md');
    if (!(await fileExists(agentsMdPath))) {
      const agentsMdContent = generateAgentsMd({
        agentName: def.name,
        title: def.title,
        companyName: 'Chem-Dry',
        isManager: def.isManager,
        userMdPath: '/Users/aidenhdee/paperclip/USER.md',
      });
      await fs.writeFile(agentsMdPath, agentsMdContent, 'utf-8');
      console.log(`  WROTE: ${agentsMdPath}`);
    } else {
      console.log(`  SKIP: AGENTS.md already exists at ${agentsMdPath}`);
    }

    // Insert into DB
    await sql`
      INSERT INTO agents (id, company_id, name, role, title, status, reports_to, adapter_type, adapter_config, runtime_config, permissions, budget_monthly_cents, spent_monthly_cents, metadata, icon)
      VALUES (
        ${agentId},
        ${CHEMDRY_COMPANY_ID},
        ${def.name},
        ${def.role},
        ${def.title},
        'idle',
        ${def.reportsTo},
        'claude_local',
        ${sql.json(adapterConfig)},
        ${sql.json(DEFAULT_RUNTIME_CONFIG)},
        ${sql.json({})},
        0,
        0,
        ${null},
        ${def.icon}
      )
    `;
    console.log(`  CREATED: ${def.name} (${agentId}) in Chem-Dry, reports to ${def.reportsTo}`);
  }
}

// ---------------------------------------------------------------------------
// Step 5: Create Automagic AI marketing team
// ---------------------------------------------------------------------------

async function createAutomagicTeam(existingAgents: DbAgent[]) {
  console.log('\n=== Step 5: Creating Automagic AI marketing team ===');

  // Track created agent IDs by slug for reports_to linking
  const createdBySlug: Record<string, string> = {};

  // First pass: create Maven (reports to Slate)
  // Second pass: create others (report to Maven)
  // Sort so maven is first
  const sorted = [...AUTOMAGIC_AGENTS].sort((a, b) => {
    if (a.reportsToSlug === null) return -1;
    if (b.reportsToSlug === null) return 1;
    return 0;
  });

  for (const def of sorted) {
    const existing = existingAgents.find(
      a => a.name === def.name && a.company_id === AUTOMAGIC_COMPANY_ID
    );
    if (existing) {
      console.log(`  SKIP: ${def.name} already exists in Automagic (${existing.id})`);
      createdBySlug[def.slug] = existing.id;
      // Still generate AGENTS.md if missing for pre-existing agents
      const existingWorkspaceDir = path.join(AUTOMAGIC_AGENTS_DIR, def.slug);
      const existingAgentsMdPath = path.join(existingWorkspaceDir, 'AGENTS.md');
      if (!(await fileExists(existingAgentsMdPath))) {
        await fs.mkdir(existingWorkspaceDir, { recursive: true });
        const agentsMdContent = generateAgentsMd({
          agentName: def.name,
          title: def.title,
          companyName: 'Automagic AI',
          isManager: def.isManager,
          userMdPath: '/Users/aidenhdee/paperclip/USER.md',
        });
        await fs.writeFile(existingAgentsMdPath, agentsMdContent, 'utf-8');
        console.log(`  WROTE: AGENTS.md for existing ${def.name} at ${existingAgentsMdPath}`);
      }
      continue;
    }

    // Also check DB directly in case we just created it in a previous iteration
    const [dbCheck] = await sql`
      SELECT id FROM agents WHERE name = ${def.name} AND company_id = ${AUTOMAGIC_COMPANY_ID} LIMIT 1
    `;
    if (dbCheck) {
      console.log(`  SKIP: ${def.name} already exists in Automagic (${dbCheck.id})`);
      createdBySlug[def.slug] = dbCheck.id;
      // Still generate AGENTS.md if missing
      const dbCheckWorkspaceDir = path.join(AUTOMAGIC_AGENTS_DIR, def.slug);
      const dbCheckAgentsMdPath = path.join(dbCheckWorkspaceDir, 'AGENTS.md');
      if (!(await fileExists(dbCheckAgentsMdPath))) {
        await fs.mkdir(dbCheckWorkspaceDir, { recursive: true });
        const agentsMdContent = generateAgentsMd({
          agentName: def.name,
          title: def.title,
          companyName: 'Automagic AI',
          isManager: def.isManager,
          userMdPath: '/Users/aidenhdee/paperclip/USER.md',
        });
        await fs.writeFile(dbCheckAgentsMdPath, agentsMdContent, 'utf-8');
        console.log(`  WROTE: AGENTS.md for existing ${def.name} at ${dbCheckAgentsMdPath}`);
      }
      continue;
    }

    const agentId = randomUUID();
    createdBySlug[def.slug] = agentId;

    let reportsTo: string | null;
    if (def.reportsToSlug === null) {
      reportsTo = AUTOMAGIC_SLATE_ID;
    } else {
      reportsTo = createdBySlug[def.reportsToSlug] ?? null;
      if (!reportsTo) {
        console.log(`  WARN: reports_to slug '${def.reportsToSlug}' not yet created, setting to Slate`);
        reportsTo = AUTOMAGIC_SLATE_ID;
      }
    }

    const workspaceDir = path.join(AUTOMAGIC_AGENTS_DIR, def.slug);
    const adapterConfig = { ...DEFAULT_ADAPTER_CONFIG, cwd: workspaceDir };

    await fs.mkdir(workspaceDir, { recursive: true });

    // Write SOUL.md adapted for Automagic
    const openclawSoulPath = path.join(OPENCLAW_DIR, def.openclawWorkspace, 'SOUL.md');
    const openclawSoul = await readFileIfExists(openclawSoulPath);
    let soulContent: string;
    if (openclawSoul) {
      soulContent = adaptSoulForAutomagic(openclawSoul);
    } else {
      soulContent = `# ${def.name}\n\nYou are ${def.name}, the ${def.title} at Automagic AI.\n`;
    }

    const soulPath = path.join(workspaceDir, 'SOUL.md');
    if (!(await fileExists(soulPath))) {
      await fs.writeFile(soulPath, soulContent, 'utf-8');
      console.log(`  WROTE: ${soulPath}`);
    } else {
      console.log(`  SKIP: SOUL.md already exists at ${soulPath}`);
    }

    // Write AGENTS.md
    const agentsMdPath = path.join(workspaceDir, 'AGENTS.md');
    if (!(await fileExists(agentsMdPath))) {
      const agentsMdContent = generateAgentsMd({
        agentName: def.name,
        title: def.title,
        companyName: 'Automagic AI',
        isManager: def.isManager,
        userMdPath: '/Users/aidenhdee/paperclip/USER.md',
      });
      await fs.writeFile(agentsMdPath, agentsMdContent, 'utf-8');
      console.log(`  WROTE: ${agentsMdPath}`);
    } else {
      console.log(`  SKIP: AGENTS.md already exists at ${agentsMdPath}`);
    }

    await sql`
      INSERT INTO agents (id, company_id, name, role, title, status, reports_to, adapter_type, adapter_config, runtime_config, permissions, budget_monthly_cents, spent_monthly_cents, metadata, icon)
      VALUES (
        ${agentId},
        ${AUTOMAGIC_COMPANY_ID},
        ${def.name},
        ${def.role},
        ${def.title},
        'idle',
        ${reportsTo},
        'claude_local',
        ${sql.json(adapterConfig)},
        ${sql.json(DEFAULT_RUNTIME_CONFIG)},
        ${sql.json({})},
        0,
        0,
        ${null},
        ${def.icon}
      )
    `;
    console.log(`  CREATED: ${def.name} (${agentId}) in Automagic, reports to ${reportsTo}`);
  }

  // Fix-up pass: ensure reports_to is correct for all agents that should
  // report to Maven (they may have been created with Slate if Maven wasn't
  // in createdBySlug yet on a prior run).
  const mavenId = createdBySlug['cmo'];
  if (mavenId) {
    for (const def of AUTOMAGIC_AGENTS) {
      if (def.reportsToSlug !== 'cmo') continue;
      const agentId = createdBySlug[def.slug];
      if (!agentId) continue;
      const [row] = await sql`
        SELECT reports_to FROM agents WHERE id = ${agentId}
      `;
      if (row && row.reports_to !== mavenId) {
        await sql`UPDATE agents SET reports_to = ${mavenId} WHERE id = ${agentId}`;
        console.log(`  FIXED: ${def.name} reports_to updated from ${row.reports_to} to Maven (${mavenId})`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step 6: Create "Personal" company and agents
// ---------------------------------------------------------------------------

async function createPersonalCompany() {
  console.log('\n=== Step 6: Creating Personal company and agents ===');

  // Check if Personal company already exists
  const [existingCompany] = await sql`
    SELECT id FROM companies WHERE name = 'Personal' LIMIT 1
  `;

  let companyId: string;
  if (existingCompany) {
    companyId = existingCompany.id;
    console.log(`  SKIP: Personal company already exists (${companyId})`);
  } else {
    companyId = randomUUID();
    await sql`
      INSERT INTO companies (id, name, description, status, budget_monthly_cents, spent_monthly_cents)
      VALUES (
        ${companyId},
        'Personal',
        'Personal agents and tools',
        'active',
        0,
        0
      )
    `;
    console.log(`  CREATED: Personal company (${companyId})`);
  }

  // Define personal agents
  const personalAgents = [
    {
      name: 'Bob the Builder',
      slug: 'bob',
      role: 'engineer',
      title: 'Infrastructure Engineer',
      openclawWorkspace: null as string | null, // no OpenClaw counterpart, use custom
    },
    {
      name: 'Doogie',
      slug: 'doogie',
      role: 'advisor',
      title: 'Health Advisor',
      openclawWorkspace: 'workspace-doogie',
    },
  ];

  for (const def of personalAgents) {
    const [existing] = await sql`
      SELECT id FROM agents WHERE name = ${def.name} AND company_id = ${companyId} LIMIT 1
    `;
    if (existing) {
      console.log(`  SKIP: ${def.name} already exists in Personal (${existing.id})`);
      continue;
    }

    const agentId = randomUUID();
    const workspaceDir = path.join(PERSONAL_AGENTS_DIR, def.slug);
    const adapterConfig = { ...DEFAULT_ADAPTER_CONFIG, cwd: workspaceDir };

    await fs.mkdir(workspaceDir, { recursive: true });

    // Write SOUL.md
    let soulContent: string;
    if (def.openclawWorkspace) {
      const openclawSoulPath = path.join(OPENCLAW_DIR, def.openclawWorkspace, 'SOUL.md');
      const openclawSoul = await readFileIfExists(openclawSoulPath);
      if (openclawSoul) {
        soulContent = adaptSoulForPaperclip(openclawSoul, 'Personal');
      } else {
        soulContent = `# ${def.name}\n\nYou are ${def.name}, the ${def.title}.\n`;
      }
    } else {
      // Bob the Builder: custom SOUL.md
      soulContent = `# Bob the Builder

## Core Identity

You are Bob the Builder, an Infrastructure Engineer. Your role is to design, build, and maintain robust infrastructure, CI/CD pipelines, development tooling, and automation systems. You focus on reliability, reproducibility, and developer experience.

## Tone

Practical, direct, and solution-oriented. You prefer working solutions over theoretical perfection.

## Behavioral Boundaries

- Build and maintain infrastructure automation (scripts, CI/CD, deployment pipelines).
- Manage development environments and tooling configuration.
- Debug build failures, dependency issues, and environment problems.
- Write clear documentation for infrastructure and build processes.
- Optimize build times and development workflows.

## What I Don't Do

- Make product or business strategy decisions.
- Handle customer-facing communications.
- Manage finances or budgets.
- Ignore security best practices in infrastructure setup.
`;
    }

    const soulPath = path.join(workspaceDir, 'SOUL.md');
    if (!(await fileExists(soulPath))) {
      await fs.writeFile(soulPath, soulContent, 'utf-8');
      console.log(`  WROTE: ${soulPath}`);
    } else {
      console.log(`  SKIP: SOUL.md already exists at ${soulPath}`);
    }

    await sql`
      INSERT INTO agents (id, company_id, name, role, title, status, reports_to, adapter_type, adapter_config, runtime_config, permissions, budget_monthly_cents, spent_monthly_cents, metadata, icon)
      VALUES (
        ${agentId},
        ${companyId},
        ${def.name},
        ${def.role},
        ${def.title},
        'idle',
        ${null},
        'claude_local',
        ${sql.json(adapterConfig)},
        ${sql.json(DEFAULT_RUNTIME_CONFIG)},
        ${sql.json({})},
        0,
        0,
        ${null},
        ${null}
      )
    `;
    console.log(`  CREATED: ${def.name} (${agentId}) in Personal`);
  }

  return companyId;
}

// ---------------------------------------------------------------------------
// Step 7: Copy memory files
// ---------------------------------------------------------------------------

interface MemoryCopyMapping {
  openclawWorkspace: string;
  destWorkspaceDir: string;
  agentName: string;
}

async function copyMemoryFiles(agents: DbAgent[]) {
  console.log('\n=== Step 7: Copying memory files ===');

  const mappings: MemoryCopyMapping[] = [];

  // Chem-Dry existing agents -- use the known agent subdir for memory placement
  for (const merge of CHEMDRY_MERGE_MAP) {
    const destDir = path.join(CHEMDRY_AGENTS_DIR, merge.paperclipSubdir);
    mappings.push({
      openclawWorkspace: merge.openclawWorkspace,
      destWorkspaceDir: destDir,
      agentName: merge.agentName,
    });
  }

  // Chem-Dry new agents
  for (const def of CHEMDRY_NEW_AGENTS) {
    mappings.push({
      openclawWorkspace: def.openclawWorkspace,
      destWorkspaceDir: path.join(CHEMDRY_AGENTS_DIR, def.slug),
      agentName: `${def.name} (Chem-Dry)`,
    });
  }

  // Automagic agents
  for (const def of AUTOMAGIC_AGENTS) {
    mappings.push({
      openclawWorkspace: def.openclawWorkspace,
      destWorkspaceDir: path.join(AUTOMAGIC_AGENTS_DIR, def.slug),
      agentName: `${def.name} (Automagic)`,
    });
  }

  // Personal agents with OpenClaw counterparts
  mappings.push({
    openclawWorkspace: 'workspace-doogie',
    destWorkspaceDir: path.join(PERSONAL_AGENTS_DIR, 'doogie'),
    agentName: 'Doogie (Personal)',
  });

  for (const mapping of mappings) {
    const srcBase = path.join(OPENCLAW_DIR, mapping.openclawWorkspace);

    // Copy MEMORY.md
    const srcMemoryMd = path.join(srcBase, 'MEMORY.md');
    const destMemoryMd = path.join(mapping.destWorkspaceDir, 'MEMORY.md');
    const memoryContent = await readFileIfExists(srcMemoryMd);
    if (memoryContent) {
      if (await fileExists(destMemoryMd)) {
        console.log(`  SKIP: MEMORY.md already exists at ${destMemoryMd}`);
      } else {
        await fs.mkdir(mapping.destWorkspaceDir, { recursive: true });
        await fs.writeFile(destMemoryMd, fixPathReferences(memoryContent), 'utf-8');
        console.log(`  COPIED: MEMORY.md for ${mapping.agentName} -> ${destMemoryMd}`);
      }
    }

    // Copy memory/ directory
    const srcMemoryDir = path.join(srcBase, 'memory');
    const destMemoryDir = path.join(mapping.destWorkspaceDir, 'memory');
    if (await dirExists(srcMemoryDir)) {
      if (await dirExists(destMemoryDir)) {
        // Check if it already has content (not just the dir existing)
        const existingEntries = await fs.readdir(destMemoryDir).catch(() => []);
        if (existingEntries.length > 0) {
          console.log(`  SKIP: memory/ already populated at ${destMemoryDir} (${existingEntries.length} entries)`);
        } else {
          await copyDirRecursive(srcMemoryDir, destMemoryDir);
          console.log(`  COPIED: memory/ for ${mapping.agentName} -> ${destMemoryDir}`);
        }
      } else {
        await copyDirRecursive(srcMemoryDir, destMemoryDir);
        console.log(`  COPIED: memory/ for ${mapping.agentName} -> ${destMemoryDir}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  try {
    console.log('OpenClaw -> Paperclip Migration Script');
    console.log('======================================');

    // Step 1
    await readOpenClawConfigs();

    // Step 2
    const { agents } = await getExistingState();

    // Step 3
    await mergeSoulFiles(agents);

    // Step 4
    await createChemdryNewAgents(agents);

    // Step 5
    await createAutomagicTeam(agents);

    // Step 6
    await createPersonalCompany();

    // Step 7 - re-fetch agents to include newly created ones for cwd resolution
    const allAgents = await sql<DbAgent[]>`
      SELECT id, company_id, name, role, title, status, reports_to, adapter_type, adapter_config, runtime_config, icon
      FROM agents
    `;
    await copyMemoryFiles(allAgents);

    console.log('\n=== Migration complete ===');
  } finally {
    await sql.end();
  }
}

main().catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
});
