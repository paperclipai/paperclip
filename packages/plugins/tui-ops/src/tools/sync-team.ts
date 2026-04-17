import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
const ROLE_TO_AGENT_PROFILE = {
    "Product Owner": "po",
    "Technical Team Lead": "lead",
    "Fullstack Developer": "frontend",
    "Frontend Developer": "frontend",
    "Backend Developer": "backend",
    "Quality Engineer": "qa",
    "QA Engineer": "qa",
    "UX Design": "ux",
    "UI/UX Designer": "ux",
    "Business Analyst": "ba",
    "Conversion Rate Optimization": "ba",
    "DevOps Engineer": "devops",
    "Security Engineer": "security",
    "Project Manager": "pm",
    "Tech Writer": "techwriter",
    Architect: "architect",
};
const API_BASE = "http://127.0.0.1:3100/api";
export async function syncTeam(params, ownershipPath) {
    const dryRun = params.dryRun ?? true;
    const companyId = params.companyId;
    if (!companyId)
        return { error: "companyId is required" };
    const teamInfoPath = join(dirname(ownershipPath), "team-info.json");
    let teamInfo;
    try {
        teamInfo = JSON.parse(await readFile(teamInfoPath, "utf-8"));
    }
    catch {
        return { error: `Cannot read team info: ${teamInfoPath}` };
    }
    // Load agent profile instructions if agentsDir provided
    const agentsDir = params.agentsDir ?? "";
    const profileInstructions = new Map();
    if (agentsDir) {
        for (const profile of new Set(Object.values(ROLE_TO_AGENT_PROFILE))) {
            const mdPath = join(agentsDir, profile, "agent.md");
            if (existsSync(mdPath)) {
                try {
                    profileInstructions.set(profile, await readFile(mdPath, "utf-8"));
                }
                catch {
                    // skip
                }
            }
        }
    }
    // Get existing agents
    const existingResp = await fetch(`${API_BASE}/companies/${companyId}/agents`);
    const existing = existingResp.ok
        ? (await existingResp.json())
        : [];
    const existingByJiraId = new Map();
    for (const a of existing) {
        const jid = a.metadata?.jiraAccountId;
        if (typeof jid === "string")
            existingByJiraId.set(jid, a.id);
    }
    const results = [];
    let created = 0;
    let skipped = 0;
    let updated = 0;
    const coveredProfiles = new Set();
    for (const member of teamInfo.team_members) {
        const profile = ROLE_TO_AGENT_PROFILE[member.role] ?? "frontend";
        coveredProfiles.add(profile);
        const instructionPath = agentsDir ? join(agentsDir, profile, "agent.md") : "";
        const hasInstructions = instructionPath && existsSync(instructionPath);
        const existingId = existingByJiraId.get(member.jira_account_id);
        if (existingId && dryRun) {
            skipped++;
            results.push(`⏭ ${member.name} (${member.role}) — already exists`);
            continue;
        }
        const body = {
            name: member.name,
            role: profile,
            title: `${member.role} — ${teamInfo.name}`,
            status: "idle",
            adapterType: "kiro_local",
            adapterConfig: {
                model: "auto",
                timeoutSec: 0,
                trustAllTools: true,
                ...(hasInstructions ? { agentMdPath: instructionPath } : {}),
            },
            metadata: {
                source: "team-info",
                kind: "human",
                pod: teamInfo.pod,
                humanRole: member.role,
                agentProfile: profile,
                jiraAccountId: member.jira_account_id,
                location: member.location,
                email: member.email || undefined,
                ...(hasInstructions ? { instructionPath } : {}),
            },
        };
        if (dryRun) {
            created++;
            results.push(`🔵 ${member.name} (${member.role}) → ${profile}${hasInstructions ? " +instructions" : ""} — would create`);
            continue;
        }
        if (existingId) {
            const resp = await fetch(`${API_BASE}/companies/${companyId}/agents/${existingId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (resp.ok) {
                updated++;
                results.push(`🔄 ${member.name} (${member.role}) — updated`);
            }
            else {
                const err = await resp.text();
                results.push(`❌ ${member.name} — update failed: ${err.slice(0, 100)}`);
            }
            continue;
        }
        const resp = await fetch(`${API_BASE}/companies/${companyId}/agents`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (resp.ok) {
            created++;
            results.push(`✅ ${member.name} (${member.role}) → ${profile} — created`);
        }
        else {
            const err = await resp.text();
            results.push(`❌ ${member.name} — ${resp.status}: ${err.slice(0, 100)}`);
        }
    }
    // Create AI-only agents for profiles not covered by any team member
    if (agentsDir) {
        const existingByProfile = new Set();
        for (const a of existing) {
            const prof = a.metadata?.agentProfile;
            if (typeof prof === "string")
                existingByProfile.add(prof);
        }
        for (const profile of profileInstructions.keys()) {
            if (coveredProfiles.has(profile))
                continue;
            if (existingByProfile.has(profile) && dryRun) {
                skipped++;
                results.push(`⏭ AI:${profile} — already exists`);
                continue;
            }
            const instructionPath = join(agentsDir, profile, "agent.md");
            const body = {
                name: `${profile.charAt(0).toUpperCase()}${profile.slice(1)} Agent`,
                role: profile,
                title: `AI ${profile} agent`,
                status: "idle",
                adapterType: "kiro_local",
                adapterConfig: {
                    model: "auto",
                    timeoutSec: 0,
                    trustAllTools: true,
                    agentMdPath: instructionPath,
                },
                metadata: {
                    source: "agents-dir",
                    kind: "ai",
                    agentProfile: profile,
                    instructionPath,
                },
            };
            if (dryRun) {
                created++;
                results.push(`🔵 AI:${profile} — would create`);
                continue;
            }
            const resp = await fetch(`${API_BASE}/companies/${companyId}/agents`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (resp.ok) {
                created++;
                results.push(`✅ AI:${profile} — created`);
            }
            else {
                const err = await resp.text();
                results.push(`❌ AI:${profile} — ${resp.status}: ${err.slice(0, 100)}`);
            }
        }
    }
    const summary = dryRun
        ? `DRY RUN: ${created} to create, ${skipped} existing, ${updated} to update`
        : `${created} created, ${updated} updated, ${skipped} skipped`;
    return {
        content: `${teamInfo.name} (${teamInfo.team_members.length} members)\n${summary}\n\n${results.join("\n")}`,
        data: { created, updated, skipped, dryRun, pod: teamInfo.pod },
    };
}
//# sourceMappingURL=sync-team.js.map