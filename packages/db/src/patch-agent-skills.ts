/**
 * IDEMPOTENT PATCH: Assign personalized skills to all agents based on name/role matching.
 * Safe to re-run — overwrites existing skill allowlists.
 * Post-restructuring: 250 agents across 12 companies.
 *
 * Run: DATABASE_URL="postgresql://paperclip:paperclip@127.0.0.1:54329/paperclip" npx tsx packages/db/src/patch-agent-skills.ts
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL!;
if (!url) throw new Error("DATABASE_URL is required");

const sql = postgres(url);

// Skill key format used in DB
const P = "paperclipai/paperclip/paperclip";
const PA = "paperclipai/paperclip/paperclip-create-agent";
const PP = "paperclipai/paperclip/paperclip-create-plugin";
const PM = "paperclipai/paperclip/para-memory-files";
const s = (name: string) => `local/claude-skill/${name}`;

// Agent name → skill keys
const agentSkillMap: Record<string, string[]> = {
  // === EVOHAUS CORE ===
  "ARASTIRMA": [P, s("find-skills"), PM, s("context-optimization")],
  "CRM": [P, s("concise-planning"), s("find-skills")],
  "DEPLOY": [P, s("docker-expert"), s("evohaus-deploy"), s("git-advanced-workflows"), s("careful")],
  "EMAIL": [P, s("concise-planning"), s("find-skills")],
  "GUVENLIK": [P, s("careful"), s("guard"), s("systematic-debugging"), s("verification-before-completion")],
  "ISTIHBARAT": [P, s("find-skills"), PM, s("context-optimization")],
  "OPERASYON": [P, s("concise-planning"), s("evohaus-monitor"), s("docker-expert")],
  "PAZARLAMA": [P, s("brainstorming"), s("concise-planning"), s("find-skills")],
  "REKLAM": [P, s("brainstorming"), s("concise-planning")],
  "SCRAPER-TAKIP": [P, s("systematic-debugging"), s("evohaus-monitor")],
  "SUNUCU": [P, s("docker-expert"), s("evohaus-deploy"), s("evohaus-monitor"), s("careful")],
  "TEKNIK": [P, s("architect-review"), s("typescript-expert"), s("plan-writing"), s("requesting-code-review")],
  "VERITABANI": [P, s("systematic-debugging"), s("careful")], // database/postgresql are separate company_skills
  "WHATSAPP": [P, s("concise-planning"), s("find-skills")],

  // === OPENCLAW GATEWAY ===
  "ARASTIRMA-GW": [P, s("find-skills"), PM, s("context-optimization")],
  "BELGE-ANALIZ-GW": [P, PM, s("context-optimization"), s("find-skills")],
  "CEVIRI-GW": [P, s("find-skills"), s("context-optimization")],
  "CRM-GW": [P, s("concise-planning"), s("find-skills")],
  "DEPLOY-GW": [P, s("docker-expert"), s("evohaus-deploy"), s("git-advanced-workflows"), s("careful")],
  "DESTEK-GW": [P, s("concise-planning"), s("find-skills"), PM],
  "EMAIL-GW": [P, s("concise-planning"), s("brainstorming")],
  "FELAKET-GW": [P, s("careful"), s("guard"), s("evohaus-monitor"), s("docker-expert")],
  "FINANS-GW": [P, s("concise-planning"), PM, s("context-optimization")],
  "GUVENLIK-GW": [P, s("careful"), s("guard"), s("systematic-debugging"), s("verification-before-completion")],
  "ISTIHBARAT-GW": [P, s("find-skills"), PM, s("context-optimization")],
  "KOD-KALITE-GW": [P, s("architect-review"), s("requesting-code-review"), s("typescript-expert"), s("systematic-debugging")],
  "OPERASYON-GW": [P, s("concise-planning"), s("evohaus-monitor"), s("mega-plan"), s("context-optimization")],
  "PAZARLAMA-GW": [P, s("brainstorming"), s("concise-planning"), s("mega-plan"), s("context-optimization")],
  "PERFORMANS-GW": [P, s("systematic-debugging"), s("verification-before-completion"), s("evohaus-monitor")],
  "REKLAM-GW": [P, s("brainstorming"), s("concise-planning")],
  "SCRAPER-TAKIP-GW": [P, s("systematic-debugging"), s("evohaus-monitor")],
  "SEO-GW": [P, s("brainstorming"), s("concise-planning"), s("find-skills")],
  "SUNUCU-GW": [P, s("docker-expert"), s("evohaus-deploy"), s("evohaus-monitor"), s("careful")],
  "TEKNIK-GW": [P, s("architect-review"), s("typescript-expert"), s("plan-writing"), s("mega-plan")],
  "TEST-GW": [P, s("test-driven-development"), s("systematic-debugging"), s("verification-before-completion"), s("commit")],
  "TOPLU-ISLEM-GW": [P, s("concise-planning"), s("context-optimization")],
  "UYUM-GW": [P, s("careful"), s("verification-before-completion"), PM],
  "VERI-HATTI-GW": [P, s("systematic-debugging"), s("context-optimization")],
  "VERITABANI-GW": [P, s("systematic-debugging"), s("careful")],
  "WEB-ARASTIRMA-GW": [P, s("find-skills"), PM, s("brainstorming")],
  "WHATSAPP-GW": [P, s("concise-planning"), s("find-skills")],

  // === AGENCY ENGINEERING ===
  "AI Engineer": [P, s("typescript-expert"), s("architect-review"), s("systematic-debugging"), s("plan-writing")],
  "AI Data Remediation Engineer": [P, s("systematic-debugging"), s("context-optimization")],
  "Autonomous Optimization Architect": [P, s("architect-review"), s("context-optimization"), s("systematic-debugging")],
  "Backend Architect": [P, s("architect-review"), s("typescript-expert"), s("nodejs-best-practices")],
  "Code Reviewer": [P, s("requesting-code-review"), s("typescript-expert"), s("systematic-debugging")],
  "Data Engineer": [P, s("systematic-debugging"), s("context-optimization")],
  "Database Optimizer": [P, s("systematic-debugging"), s("context-optimization")],
  "DevOps Automator": [P, s("docker-expert"), s("evohaus-deploy"), s("git-advanced-workflows"), s("careful")],
  "Embedded Firmware Engineer": [P, s("systematic-debugging"), s("plan-writing"), s("careful")],
  "Feishu Integration Developer": [P, s("typescript-expert"), s("nodejs-best-practices")],
  "Frontend Developer": [P, s("react-patterns"), s("nextjs-best-practices"), s("typescript-expert")],
  "Git Workflow Master": [P, s("git-advanced-workflows"), s("commit"), s("pr-writer")],
  "Incident Response Commander": [P, s("careful"), s("guard"), s("evohaus-monitor"), s("systematic-debugging")],
  "Mobile App Builder": [P, s("react-patterns"), s("typescript-expert")],
  "Rapid Prototyper": [P, s("brainstorming"), s("react-patterns"), s("typescript-expert")],
  "Security Engineer": [P, s("careful"), s("guard"), s("systematic-debugging"), s("verification-before-completion")],
  "Senior Developer": [P, s("typescript-expert"), s("architect-review"), s("commit"), s("pr-writer")],
  "Software Architect": [P, s("architect-review"), s("typescript-expert"), s("plan-writing"), s("requesting-code-review")],
  "SRE (Site Reliability Engineer)": [P, s("docker-expert"), s("evohaus-monitor"), s("careful"), s("guard")],
  "Technical Writer": [P, PM, s("context-optimization")],
  "Threat Detection Engineer": [P, s("careful"), s("guard"), s("systematic-debugging"), s("evohaus-monitor")],

  // === AGENCY TESTING ===
  "Accessibility Auditor": [P, s("test-driven-development"), s("verification-before-completion"), s("react-patterns")],
  "API Tester": [P, s("test-driven-development"), s("systematic-debugging"), s("verification-before-completion")],
  "Evidence Collector": [P, s("verification-before-completion"), PM],
  "Performance Benchmarker": [P, s("systematic-debugging"), s("evohaus-monitor"), s("verification-before-completion")],
  "Reality Checker": [P, s("verification-before-completion"), s("systematic-debugging")],
  "Test Results Analyzer": [P, s("test-driven-development"), s("systematic-debugging"), s("verification-before-completion")],
  "Tool Evaluator": [P, s("find-skills"), s("systematic-debugging"), s("verification-before-completion")],
  "Workflow Optimizer": [P, s("context-optimization"), s("concise-planning"), s("systematic-debugging")],

  // === AGENCY DESIGN ===
  "Brand Guardian": [P, s("brainstorming"), s("react-patterns")],
  "Image Prompt Engineer": [P, s("brainstorming"), s("context-optimization")],
  "Inclusive Visuals Specialist": [P, s("brainstorming"), s("react-patterns")],
  "UI Designer": [P, s("react-patterns"), s("nextjs-best-practices"), s("brainstorming")],
  "UX Architect": [P, s("architect-review"), s("brainstorming"), s("plan-writing")],
  "UX Researcher": [P, s("brainstorming"), PM, s("find-skills")],
  "Visual Storyteller": [P, s("brainstorming"), s("context-optimization")],
  "Whimsy Injector": [P, s("brainstorming"), s("react-patterns")],

  // === AGENCY MARKETING ===
  "AI Citation Strategist": [P, s("brainstorming"), s("find-skills")],
  "App Store Optimizer": [P, s("brainstorming"), s("find-skills")],
  "Baidu SEO Specialist": [P, s("brainstorming"), s("find-skills")],
  "Bilibili Content Strategist": [P, s("brainstorming"), s("concise-planning")],
  "China E-Commerce Operator": [P, s("brainstorming"), s("concise-planning")],
  "Content Creator": [P, s("brainstorming"), s("concise-planning")],
  "Cross-Border E-Commerce Specialist": [P, s("brainstorming"), s("concise-planning")],
  "Douyin Strategist": [P, s("brainstorming"), s("concise-planning")],
  "Growth Hacker": [P, s("brainstorming"), s("concise-planning"), s("find-skills")],
  "Instagram Curator": [P, s("brainstorming"), s("concise-planning")],
  "Kuaishou Strategist": [P, s("brainstorming"), s("concise-planning")],
  "LinkedIn Content Creator": [P, s("brainstorming"), s("concise-planning")],
  "Livestream Commerce Coach": [P, s("brainstorming"), s("concise-planning")],
  "Podcast Strategist": [P, s("brainstorming"), s("concise-planning"), PM],
  "Private Domain Operator": [P, s("brainstorming"), s("concise-planning")],
  "Reddit Community Builder": [P, s("brainstorming"), s("concise-planning")],
  "SEO Specialist": [P, s("brainstorming"), s("find-skills")],
  "Short-Video Editing Coach": [P, s("brainstorming"), s("concise-planning")],
  "Social Media Strategist": [P, s("brainstorming"), s("concise-planning"), PM],
  "TikTok Strategist": [P, s("brainstorming"), s("concise-planning")],
  "Twitter Engager": [P, s("brainstorming"), s("concise-planning")],
  "WeChat Official Account Manager": [P, s("brainstorming"), s("concise-planning")],
  "Weibo Strategist": [P, s("brainstorming"), s("concise-planning")],
  "Xiaohongshu Specialist": [P, s("brainstorming"), s("concise-planning")],
  "Zhihu Strategist": [P, s("brainstorming"), s("concise-planning"), PM],

  // === AGENCY GAME DEV ===
  "Blender Add-on Engineer": [P, s("plan-writing"), s("systematic-debugging")],
  "Game Audio Engineer": [P, s("plan-writing"), s("brainstorming")],
  "Game Designer": [P, s("brainstorming"), s("plan-writing"), PM],
  "Godot Gameplay Scripter": [P, s("systematic-debugging"), s("plan-writing")],
  "Godot Multiplayer Engineer": [P, s("systematic-debugging"), s("architect-review")],
  "Godot Shader Developer": [P, s("systematic-debugging"), s("plan-writing")],
  "Level Designer": [P, s("brainstorming"), s("plan-writing")],
  "Narrative Designer": [P, s("brainstorming"), PM],
  "Roblox Avatar Creator": [P, s("brainstorming"), s("plan-writing")],
  "Roblox Experience Designer": [P, s("brainstorming"), s("plan-writing")],
  "Roblox Systems Scripter": [P, s("systematic-debugging"), s("plan-writing")],
  "Technical Artist": [P, s("brainstorming"), s("systematic-debugging")],
  "Unity Architect": [P, s("architect-review"), s("plan-writing")],
  "Unity Editor Tool Developer": [P, s("plan-writing"), s("systematic-debugging")],
  "Unity Multiplayer Engineer": [P, s("architect-review"), s("systematic-debugging")],
  "Unity Shader Graph Artist": [P, s("brainstorming"), s("plan-writing")],
  "Unreal Multiplayer Architect": [P, s("architect-review"), s("plan-writing")],
  "Unreal Systems Engineer": [P, s("architect-review"), s("systematic-debugging")],
  "Unreal Technical Artist": [P, s("brainstorming"), s("systematic-debugging")],
  "Unreal World Builder": [P, s("brainstorming"), s("plan-writing")],

  // === AGENCY SALES ===
  "Account Strategist": [P, s("brainstorming"), s("concise-planning"), PM],
  "Deal Strategist": [P, s("brainstorming"), s("concise-planning")],
  "Discovery Coach": [P, s("brainstorming"), s("find-skills")],
  "Outbound Strategist": [P, s("brainstorming"), s("concise-planning")],
  "Pipeline Analyst": [P, s("concise-planning"), s("context-optimization")],
  "Proposal Strategist": [P, s("brainstorming"), s("concise-planning"), PM],
  "Sales Coach": [P, s("brainstorming"), s("concise-planning")],
  "Sales Engineer": [P, s("brainstorming"), s("typescript-expert")],

  // === AGENCY PRODUCT ===
  "Feedback Synthesizer": [P, PM, s("context-optimization")],
  "Product Manager": [P, s("brainstorming"), s("concise-planning"), s("plan-writing"), PM],
  "Sprint Prioritizer": [P, s("concise-planning"), s("plan-writing")],
  "Trend Researcher": [P, s("find-skills"), s("brainstorming"), PM],

  // === AGENCY PROJECT MGMT ===
  "Experiment Tracker": [P, s("verification-before-completion"), PM],
  "Jira Workflow Steward": [P, s("concise-planning"), s("plan-writing")],
  "Project Shepherd": [P, s("concise-planning"), s("plan-writing"), s("context-optimization")],
  "Senior Project Manager": [P, s("concise-planning"), s("plan-writing"), s("mega-plan")],
  "Studio Operations": [P, s("concise-planning"), s("evohaus-monitor")],
  "Studio Producer": [P, s("concise-planning"), s("plan-writing")],

  // === AGENCY SUPPORT ===
  "Analytics Reporter": [P, s("context-optimization"), s("concise-planning")],
  "Executive Summary Generator": [P, s("concise-planning"), PM, s("context-optimization")],
  "Finance Tracker": [P, s("concise-planning"), PM],
  "Infrastructure Maintainer": [P, s("docker-expert"), s("evohaus-monitor"), s("careful")],
  "Legal Compliance Checker": [P, s("careful"), s("verification-before-completion"), PM],
  "Support Responder": [P, s("concise-planning"), s("find-skills")],

  // === AGENCY PAID MEDIA ===
  "Ad Creative Strategist": [P, s("brainstorming"), s("concise-planning")],
  "Paid Media Auditor": [P, s("verification-before-completion"), s("concise-planning")],
  "Paid Social Strategist": [P, s("brainstorming"), s("concise-planning")],
  "PPC Campaign Strategist": [P, s("brainstorming"), s("concise-planning")],
  "Programmatic & Display Buyer": [P, s("concise-planning"), s("context-optimization")],
  "Search Query Analyst": [P, s("find-skills"), s("context-optimization")],
  "Tracking & Measurement Specialist": [P, s("verification-before-completion"), s("systematic-debugging")],

  // === AGENCY SPECIALIZED (post-restructuring: 16 deleted agents removed) ===
  "Agents Orchestrator": [P, PA, s("skill-zeka"), s("mega-plan")],
  "Compliance Auditor": [P, s("careful"), s("verification-before-completion"), PM],
  "Data Consolidation Agent": [P, s("context-optimization"), s("concise-planning")],
  "Developer Advocate": [P, s("brainstorming"), s("find-skills"), s("typescript-expert")],
  "Document Generator": [P, PM, s("concise-planning")],
  "Government Digital Presales Consultant": [P, s("brainstorming"), s("concise-planning")],
  "LSP/Index Engineer": [P, s("typescript-expert"), s("architect-review"), s("systematic-debugging")],
  "MCP Builder": [P, s("typescript-expert"), s("nodejs-best-practices"), s("architect-review")],
  "Model QA Specialist": [P, s("test-driven-development"), s("verification-before-completion"), s("systematic-debugging")],
  "Report Distribution Agent": [P, s("concise-planning"), PM],
  "Sales Data Extraction Agent": [P, s("context-optimization"), s("concise-planning")],
  "Supply Chain Strategist": [P, s("concise-planning"), s("context-optimization")],
  "Workflow Architect": [P, s("architect-review"), s("plan-writing"), s("context-optimization")],

  // === AGENCY ACADEMIC ===
  "Anthropologist": [P, PM, s("brainstorming"), s("context-optimization")],
  "Geographer": [P, PM, s("find-skills")],
  "Historian": [P, PM, s("context-optimization"), s("brainstorming")],
  "Narratologist": [P, PM, s("brainstorming")],
  "Psychologist": [P, PM, s("brainstorming"), s("context-optimization")],

  // === AGENCY SPATIAL ===
  "macOS Spatial/Metal Engineer": [P, s("plan-writing"), s("systematic-debugging")],
  "Terminal Integration Specialist": [P, s("typescript-expert"), s("systematic-debugging")],
  "visionOS Spatial Engineer": [P, s("plan-writing"), s("brainstorming")],
  "XR Cockpit Interaction Specialist": [P, s("plan-writing"), s("brainstorming")],
  "XR Immersive Developer": [P, s("plan-writing"), s("brainstorming")],
  "XR Interface Architect": [P, s("architect-review"), s("plan-writing")],

  // === GSTACK ===
  "gstack-stratejist": [P, s("mega-plan"), s("brainstorming"), s("skill-zeka")],
  "gstack-eng-manager": [P, s("architect-review"), s("plan-writing"), s("requesting-code-review")],
  "gstack-code-reviewer": [P, s("requesting-code-review"), s("typescript-expert"), s("systematic-debugging")],
  "gstack-debugger": [P, s("systematic-debugging"), s("careful"), s("verification-before-completion")],
  "gstack-design-lead": [P, s("brainstorming"), s("react-patterns")],
  "gstack-documenter": [P, PM, s("context-optimization")],
  "gstack-qa-engineer": [P, s("test-driven-development"), s("verification-before-completion")],
  "gstack-release-engineer": [P, s("docker-expert"), s("evohaus-deploy"), s("git-advanced-workflows")],
  "gstack-retro-lead": [P, s("concise-planning"), PM],
  "gstack-safety-officer": [P, s("careful"), s("guard"), s("evohaus-monitor")],

  // === SENTINEL ===
  "SENTINEL": [P, s("evohaus-monitor"), s("careful"), s("guard")],
  "EVOHAUS Security Codex": [P, s("careful"), s("guard"), s("verification-before-completion")],
  "EVOHAUS Security Gemini": [P, s("careful"), s("guard"), s("verification-before-completion")],
};

// Role-based fallback for agents not in the map (company-specific roles)
const roleFallback: Record<string, string[]> = {
  "ceo": [P, PA, PM, s("mega-plan"), s("brainstorming"), s("context-optimization"), s("skill-zeka")],
  "cto": [P, PP, s("architect-review"), s("typescript-expert"), s("systematic-debugging"), s("plan-writing"), s("requesting-code-review"), s("uncle-bob-craft")],
  "coo": [P, s("concise-planning"), s("evohaus-monitor"), s("mega-plan"), s("context-optimization")],
  "cfo": [P, s("concise-planning"), PM, s("context-optimization")],
  "cmo": [P, s("brainstorming"), s("concise-planning"), PM, s("context-optimization")],
  "cgo": [P, s("brainstorming"), s("concise-planning"), s("mega-plan"), s("context-optimization")],
  "engineer": [P, s("typescript-expert"), s("systematic-debugging"), s("commit"), s("pr-writer"), s("uncle-bob-craft")],
  "backend_engineer": [P, s("typescript-expert"), s("nodejs-best-practices"), s("systematic-debugging"), s("commit"), s("database"), s("postgresql")],
  "frontend_engineer": [P, s("react-patterns"), s("nextjs-best-practices"), s("typescript-expert"), s("commit")],
  "lead_engineer": [P, s("typescript-expert"), s("architect-review"), s("plan-writing"), s("commit"), s("uncle-bob-craft")],
  "mobile_engineer": [P, s("react-patterns"), s("typescript-expert"), s("commit"), s("mobile-developer")],
  "devops": [P, s("docker-expert"), s("evohaus-deploy"), s("git-advanced-workflows"), s("careful")],
  "qa_engineer": [P, s("test-driven-development"), s("systematic-debugging"), s("verification-before-completion"), s("commit"), s("test-automator")],
  "product_manager": [P, s("brainstorming"), s("concise-planning"), s("plan-writing"), PM],
  "designer": [P, s("brainstorming"), s("react-patterns"), s("nextjs-best-practices"), s("antigravity-design-expert"), s("radix-ui-design-system"), s("tailwind-design-system"), s("ux-researcher-designer"), s("design-guide"), s("concise-planning")],
  "security": [P, s("careful"), s("guard"), s("systematic-debugging"), s("verification-before-completion"), s("api-security-best-practices")],
  "customer_success": [P, s("concise-planning"), PM, s("find-skills")],
  "data_analyst": [P, s("systematic-debugging"), s("context-optimization"), s("concise-planning")],
  "marketing": [P, s("brainstorming"), s("concise-planning"), PM],
  "sales": [P, s("brainstorming"), s("concise-planning"), PM],
  "project_lead": [P, PA, s("concise-planning"), s("plan-writing"), s("context-optimization")],
  "general": [P, s("brainstorming"), s("concise-planning")],
  "aso": [P, s("brainstorming"), s("find-skills")],
  "growth": [P, s("brainstorming"), s("concise-planning"), s("find-skills")],
  "pm": [P, s("concise-planning"), s("plan-writing"), PM],
  "qa": [P, s("systematic-debugging"), s("test-driven-development"), s("verification-before-completion")],
  "researcher": [P, PM, s("find-skills"), s("context-optimization")],
  "support": [P, s("concise-planning"), s("find-skills")],
  // OpenClaw specific roles
  "eng_security": [P, s("careful"), s("guard"), s("systematic-debugging")],
  "eng_i18n": [P, s("find-skills"), s("context-optimization")],
  "eng_deploy": [P, s("docker-expert"), s("evohaus-deploy"), s("careful")],
  "eng_research": [P, s("find-skills"), PM, s("context-optimization")],
  "eng_quality": [P, s("architect-review"), s("requesting-code-review"), s("systematic-debugging")],
  "eng_test": [P, s("test-driven-development"), s("systematic-debugging"), s("verification-before-completion")],
  "eng_perf": [P, s("systematic-debugging"), s("evohaus-monitor")],
  "eng_data": [P, s("systematic-debugging"), s("context-optimization")],
  "eng_batch": [P, s("concise-planning"), s("context-optimization")],
  "eng_database": [P, s("systematic-debugging"), s("careful")],
  "ops_dr": [P, s("careful"), s("guard"), s("evohaus-monitor")],
  "ops_crm": [P, s("concise-planning"), s("find-skills")],
  "ops_scraper": [P, s("systematic-debugging"), s("evohaus-monitor")],
  "ops_vps": [P, s("docker-expert"), s("evohaus-monitor"), s("careful")],
  "ops_messaging": [P, s("concise-planning"), s("find-skills")],
  "ops_infra_monitor": [P, s("evohaus-monitor"), s("careful"), s("guard")],
  "legal_compliance": [P, s("careful"), s("verification-before-completion"), PM],
  "finance_reporting": [P, s("concise-planning"), PM, s("context-optimization")],
  "mkt_seo": [P, s("brainstorming"), s("concise-planning"), s("find-skills")],
  "mkt_email": [P, s("concise-planning"), s("brainstorming")],
  "mkt_outreach": [P, s("brainstorming"), s("concise-planning")],
  "mkt_intel": [P, s("find-skills"), PM, s("context-optimization")],
  "research_docs": [P, PM, s("context-optimization"), s("find-skills")],
  "research_web": [P, s("find-skills"), PM, s("brainstorming")],
};

// Default fallback
const defaultSkills = [P, s("concise-planning")];

async function main() {
  // Get ALL agents (idempotent — override existing skills)
  const agents = await sql`
    SELECT id, name, role
    FROM agents
    ORDER BY name
  `;

  console.log(`Found ${agents.length} agents without skills`);

  let updated = 0;
  let nameMatched = 0;
  let roleMatched = 0;
  let defaultUsed = 0;

  for (const agent of agents) {
    // 1. Try exact name match
    let skills = agentSkillMap[agent.name];
    if (skills) {
      nameMatched++;
    } else {
      // 2. Try role fallback
      skills = roleFallback[agent.role];
      if (skills) {
        roleMatched++;
      } else {
        // 3. Try partial role match (agency_* roles)
        const rolePrefix = agent.role.split("_").slice(0, 2).join("_");
        if (rolePrefix.startsWith("agency_engineering")) {
          skills = [P, s("typescript-expert"), s("systematic-debugging"), s("commit")];
        } else if (rolePrefix.startsWith("agency_testing")) {
          skills = [P, s("test-driven-development"), s("systematic-debugging"), s("verification-before-completion")];
        } else if (rolePrefix.startsWith("agency_marketing")) {
          skills = [P, s("brainstorming"), s("concise-planning")];
        } else if (rolePrefix.startsWith("agency_design")) {
          skills = [P, s("brainstorming"), s("react-patterns")];
        } else if (rolePrefix.startsWith("agency_game")) {
          skills = [P, s("brainstorming"), s("plan-writing")];
        } else if (rolePrefix.startsWith("agency_sales")) {
          skills = [P, s("brainstorming"), s("concise-planning")];
        } else if (rolePrefix.startsWith("agency_product")) {
          skills = [P, s("brainstorming"), s("plan-writing")];
        } else if (rolePrefix.startsWith("agency_project")) {
          skills = [P, s("concise-planning"), s("plan-writing")];
        } else if (rolePrefix.startsWith("agency_support")) {
          skills = [P, s("concise-planning"), s("find-skills")];
        } else if (rolePrefix.startsWith("agency_specialized")) {
          skills = [P, s("find-skills"), s("context-optimization")];
        } else if (rolePrefix.startsWith("agency_academic")) {
          skills = [P, PM, s("context-optimization")];
        } else if (rolePrefix.startsWith("agency_spatial")) {
          skills = [P, s("plan-writing"), s("brainstorming")];
        } else if (rolePrefix.startsWith("agency_paid")) {
          skills = [P, s("brainstorming"), s("concise-planning")];
        } else {
          skills = defaultSkills;
          defaultUsed++;
        }
        roleMatched++;
      }
    }

    const allowlist = { allowed: skills, blocked: [], enabled: true };

    await sql`
      UPDATE agents
      SET runtime_config = jsonb_set(
        COALESCE(runtime_config, '{}'::jsonb),
        '{skillAllowlist}',
        ${sql.json(allowlist)}
      ),
      updated_at = NOW()
      WHERE id = ${agent.id}
    `;
    updated++;
  }

  console.log(`\nDone! Updated ${updated} agents`);
  console.log(`  Name matched: ${nameMatched}`);
  console.log(`  Role matched: ${roleMatched}`);
  console.log(`  Default fallback: ${defaultUsed}`);

  // Verify
  const remaining = await sql`
    SELECT count(*)::int as cnt FROM agents
    WHERE jsonb_array_length(COALESCE(runtime_config->'skillAllowlist'->'allowed','[]'::jsonb)) <= 1
  `;
  console.log(`\nRemaining without skills: ${remaining[0].cnt}`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
