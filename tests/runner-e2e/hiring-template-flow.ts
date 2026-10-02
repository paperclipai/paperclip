import { readFile } from "node:fs/promises";
import { loadDefaultAgentInstructionsBundle } from "../../server/src/services/default-agent-instructions.js";
import { readChatOutputDocument, type ChatFlowInput, type ChatIssue, type ChatRun } from "./chat-flow.js";
import { collectRunEvents } from "./run-observations.js";
import { HIRING_TEMPLATE_GRADER_VERSION, HIRING_TEMPLATE_READ_FILES, HIRING_TEMPLATE_SKILL_KEY,
  HIRING_TEMPLATE_SOURCE_FILES, hiringTemplateDefinitionDigest, hiringTemplateScenario } from "./hiring-template-cases.js";
import { gradeHiringTemplate, hiringTemplateHash, hiringTemplateSize, type HiringAgent, type HiringDocument,
  type HiringInstructionSnapshot, type HiringTemplateEvidence } from "./hiring-template-scoring.js";
import type { RunnerApi } from "./api.js";

export async function readHiringInstructions(api: Pick<RunnerApi, "get">, agentId: string): Promise<HiringInstructionSnapshot> {
  const bundle = await api.get<{ mode: string | null; entryFile: string; files: Array<{ path: string; binary?: boolean }> }>(`/api/agents/${agentId}/instructions-bundle`);
  const files: Record<string, string> = {};
  // Agent-home notes may be added by a run. Retain the entry and legacy CEO
  // policy files so the baseline and candidate default bundles can be compared.
  for (const file of bundle.files.filter(file => !file.binary && (file.path === bundle.entryFile || ["HEARTBEAT.md", "SOUL.md", "TOOLS.md"].includes(file.path)))) {
    const detail = await api.get<{ content: string }>(`/api/agents/${agentId}/instructions-bundle/file?path=${encodeURIComponent(file.path)}`);
    files[file.path] = detail.content;
  }
  return { entryFile: bundle.entryFile, mode: bundle.mode, files };
}

async function readHiringSkillSelections(api: Pick<RunnerApi, "get">, companyId: string, agentId: string) {
  const snapshot = await api.get<{ desiredSkills: string[]; desiredSkillEntries: unknown[] }>(`/api/agents/${agentId}/skills?companyId=${companyId}`);
  return { desiredSkills: snapshot.desiredSkills, desiredSkillEntries: snapshot.desiredSkillEntries };
}

export async function readHiringTemplateSources(api: Pick<RunnerApi, "get">, companyId: string, leadId: string) {
  const expectedCeoFiles = await loadDefaultAgentInstructionsBundle("ceo");
  const expectedSourceHashes: Record<string, string> = {}, servedSourceHashes: Record<string, string> = {};
  const sourceSizes: Record<string, ReturnType<typeof hiringTemplateSize>> = {};
  for (const relative of [...HIRING_TEMPLATE_SOURCE_FILES, ...Object.keys(expectedCeoFiles).map(file => `server/src/onboarding-assets/ceo/${file}`)]) {
    const content = await readFile(new URL(`../../${relative}`, import.meta.url), "utf8");
    expectedSourceHashes[relative] = hiringTemplateHash(content);
    sourceSizes[relative] = hiringTemplateSize(content);
  }
  const leadInstructions = await readHiringInstructions(api, leadId);
  for (const [file, content] of Object.entries(leadInstructions.files)) servedSourceHashes[`server/src/onboarding-assets/ceo/${file}`] = hiringTemplateHash(content);
  const skills = await api.get<Array<{ id: string; key: string }>>(`/api/companies/${companyId}/skills`);
  const creator = skills.find(skill => skill.key === HIRING_TEMPLATE_SKILL_KEY);
  if (!creator) throw new Error("Production hiring skill is absent from the company library");
  const assigned = await api.get<{ desiredSkills: string[] }>(`/api/agents/${leadId}/skills?companyId=${companyId}`);
  let coderReference = "";
  for (const file of [...HIRING_TEMPLATE_READ_FILES, "references/baseline-role-guide.md"]) {
    const detail = await api.get<{ content: string }>(`/api/companies/${companyId}/skills/${creator.id}/files?path=${encodeURIComponent(file)}`);
    servedSourceHashes[`skills/paperclip-create-agent/${file}`] = hiringTemplateHash(detail.content);
    if (file === "references/agents/coder.md") coderReference = detail.content;
  }
  // The loader and execution contract are source provenance, not served skill
  // reads. Their bytes are retained separately from the equality checks.
  delete expectedSourceHashes["server/src/services/default-agent-instructions.ts"];
  delete expectedSourceHashes["server/src/onboarding-assets/default/AGENTS.md"];
  return { expectedCeoFiles, leadInstructions, expectedSourceHashes, servedSourceHashes,
    sourceSizes, assignedSkills: assigned.desiredSkills, coderReference, creatorSkillId: creator.id,
    loaderHash: hiringTemplateHash(await readFile(new URL("../../server/src/services/default-agent-instructions.ts", import.meta.url), "utf8")),
    executionContractHash: hiringTemplateHash(await readFile(new URL("../../server/src/onboarding-assets/default/AGENTS.md", import.meta.url), "utf8")) };
}

export function renderHiringCoderExample(reference: string, agentName: string, companyName: string, managerTitle: string, issuePrefix: string) {
  const example = reference.match(/```md\s*\n([\s\S]*?)\n```/)?.[1];
  if (!example?.trim()) throw new Error("Production coder reference has no AGENTS.md example");
  return example.replaceAll("{{agentName}}", agentName).replaceAll("{{companyName}}", companyName).replaceAll("{{managerTitle}}", managerTitle).replaceAll("{{issuePrefix}}", issuePrefix);
}

export async function runHiringTemplateFlow(context: {
  input: ChatFlowInput; issue(): ChatIssue; turn(message: string, count: number): Promise<void>;
  tasks(): Promise<ChatIssue[]>; allRuns(): Promise<ChatRun[]>;
}) {
  const { input, turn, tasks, allRuns } = context;
  const { api, fixtures: f } = input;
  const company = `/api/companies/${f.company.id}`;
  const account = f.aiConnection;
  if (!account) throw new Error("Hiring-template fixture requires a managed execution account");
  const issuePrefix = f.company.issuePrefix;
  if (!issuePrefix) throw new Error("Hiring-template fixture requires the actual company issue prefix");
  const evidence: HiringTemplateEvidence = {
    leadId: f.agent.id, chatIssueId: "", hireName: "", marker: "", projectId: "", inputs: [], expectedCeoFiles: {},
    expectedSourceHashes: {}, servedSourceHashes: {}, assignedSkills: [], coderExample: "",
    agents: [], tasks: [], runs: [], readRuns: [], connectionId: account.connectionId, binding: account.binding,
  };
  let source: Awaited<ReturnType<typeof readHiringTemplateSources>> | undefined;
  let scenario: ReturnType<typeof hiringTemplateScenario> | undefined;
  async function refresh() {
    const observed = await Promise.all([api.get<HiringAgent[]>(`${company}/agents`), tasks(), allRuns()]);
    [evidence.agents, evidence.tasks, evidence.runs] = observed;
    evidence.readRuns = await Promise.all(evidence.runs.map(async run => {
      const events = await collectRunEvents<{ seq?: number; eventType?: string; payload?: unknown; createdAt?: string }>(
        (afterSeq, limit) => api.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=${limit}`),
      );
      return { runId: run.id, agentId: run.agentId, events };
    }));
  }
  try {
    await api.patch(`${company}/budgets`, { budgetMonthlyCents: 1_000 });
    await api.patch(`/api/agents/${f.agent.id}/budgets`, { budgetMonthlyCents: 1_000 });
    source = await readHiringTemplateSources(api, f.company.id, f.agent.id);
    Object.assign(evidence, source);
    await input.evidence("hiring-template-source.json", { ...source, definitionDigest: hiringTemplateDefinitionDigest });
    if (Object.entries(source.expectedSourceHashes).some(([file, hash]) => source!.servedSourceHashes[file] !== hash)) {
      throw new Error("Hiring-template served source differs from the evaluated revision; comparison is uncomparable");
    }
    const project = await api.post<{ id: string; name: string }>(`${company}/projects`, {
      name: `Label fixtures ${input.nonce}`, description: "Repository-free JSON normalization fixtures.",
    });
    scenario = hiringTemplateScenario(input.nonce, project.name);
    Object.assign(evidence, { hireName: scenario.hireName, marker: scenario.marker, inputs: scenario.inputs, projectId: project.id,
      coderExample: renderHiringCoderExample(source.coderReference, scenario.hireName, f.company.name, String((await api.get<{ title: string }>(`/api/agents/${f.agent.id}`)).title), issuePrefix) });
    await turn(scenario.initialPrompt, 2);
    evidence.chatIssueId = context.issue().id;
    const initial = await tasks();
    if (initial.length !== 1) throw new Error("Hiring-template first turn must create exactly one coder task");
    evidence.first = await readChatOutputDocument(api, initial[0]!.id, scenario.marker) as HiringDocument;
    await refresh();
    const hired = evidence.agents.find(agent => agent.name === scenario!.hireName);
    if (!hired) throw new Error("Hiring-template coder was not created");
    evidence.hiredInstructions = await readHiringInstructions(api, hired.id);
    evidence.hiredSkills = await readHiringSkillSelections(api, f.company.id, hired.id);
    await input.capture("hiring-template-created", "Production CEO hired a coder and delivered its first fixture", "hiring-template-created.png");
    await input.evidence("hiring-template-initial.json", evidence);
    await turn(scenario.reusePrompt(initial[0]!.identifier ?? initial[0]!.id), 4);
    const second = (await tasks()).find(task => task.id !== evidence.first!.issueId);
    if (!second) throw new Error("Hiring-template reuse task is absent");
    evidence.second = await readChatOutputDocument(api, second.id, `REUSE${scenario.marker}`) as HiringDocument;
    evidence.firstAfterReuse = await api.get<HiringDocument>(`/api/issues/${evidence.first.issueId}/documents/${encodeURIComponent(evidence.first.key)}`);
    await turn(scenario.statusPrompt(initial[0]!.identifier ?? initial[0]!.id, second.identifier ?? second.id), 5);
    evidence.hiredInstructionsAfterReuse = await readHiringInstructions(api, hired.id);
    evidence.hiredSkillsAfterReuse = await readHiringSkillSelections(api, f.company.id, hired.id);
    await refresh();
    const result = gradeHiringTemplate(evidence);
    for (const check of result.checks) input.check?.(`hiringTemplates.${check.dimension}.${check.id}`, check.passed, check.detail);
    await input.evidence("hiring-template.json", { schema: HIRING_TEMPLATE_GRADER_VERSION, definitionDigest: hiringTemplateDefinitionDigest,
      budgetGuard: { companyMonthlyCents: 1_000, leadMonthlyCents: 1_000 }, scenario, source, evidence, result });
    const failed = result.checks.filter(check => !check.passed);
    if (!result.outcomePassed) throw new Error(`Hiring-template workflow outcome failed: ${failed.filter(check => check.dimension === "outcome").map(check => check.id).join(", ")}`);
    if (result.comparisonStatus === "uncomparable") throw new Error(`Hiring-template source coverage is uncomparable: ${failed.filter(check => check.dimension === "coverage").map(check => check.id).join(", ")}`);
  } finally {
    let observationError: string | undefined;
    try { await refresh(); } catch (error) { observationError = String(error); }
    await input.evidence("hiring-template.json", { schema: HIRING_TEMPLATE_GRADER_VERSION, definitionDigest: hiringTemplateDefinitionDigest,
      budgetGuard: { companyMonthlyCents: 1_000, leadMonthlyCents: 1_000 },
      scenario, source, evidence, result: gradeHiringTemplate(evidence), observationError });
  }
}
