import type {
  AgentDetail,
  AgentInstructionsBundle,
  AgentSkillSnapshot,
  CompanySkillListItem,
} from "@paperclipai/shared";
import {
  storybookHiredAgent,
  storybookAgents,
  storybookIssues,
  storybookSecrets,
} from "../../fixtures/paperclipData";
import { models as claudeModels } from "@paperclipai/adapter-claude-local";
import { models as openCodeModels } from "@paperclipai/adapter-opencode-local";
import { storybookEnvironments } from "../../fixtures/onboardingEnvironment";
import { models as codexModels } from "@paperclipai/adapter-codex-local";
import { runtimeTestResult, type TestOutcome } from "../new-agent-fixtures";
export const COMPANY = "company-storybook";
export const ID = "agent-settings-preview";
export const REF = "nova";

export const library = [
  [
    "paperclip",
    "Paperclip",
    "Coordinate tasks, report progress, and work with your team.",
  ],
  [
    "design-guide",
    "Design guide",
    "Build consistent interfaces using the product’s design system.",
  ],
  [
    "browser-testing",
    "Browser testing",
    "Verify user journeys and catch visual regressions.",
  ],
  [
    "release-checklist",
    "Release checklist",
    "Prepare changes for review and verify release readiness.",
  ],
].map(([key, name, description]) => ({
  id: `settings-skill-${key}`,
  companyId: COMPANY,
  key,
  slug: key,
  name,
  description,
  sourceType: "local_path",
  sourceLocator: `skills/${key}`,
  sourceRef: null,
  trustLevel: "markdown_only",
  compatibility: "compatible",
  fileInventory: [{ path: "SKILL.md", kind: "skill" }],
  createdAt: new Date(),
  updatedAt: new Date(),
  attachedAgentCount: 1,
  editable: true,
  editableReason: null,
  sourceLabel: "Organization library",
  sourceBadge: "local",
  sourcePath: `skills/${key}`,
  catalogKind: null,
  originHash: null,
  packageName: null,
  packageVersion: null,
  iconUrl: null,
  color: null,
  tagline: null,
  authorName: null,
  homepageUrl: null,
  categories: [],
  sharingScope: "company",
  publicShareToken: null,
  forkedFromSkillId: null,
  forkedFromCompanyId: null,
  starCount: 0,
  installCount: 1,
  forkCount: 0,
  currentVersionId: null,
})) as CompanySkillListItem[];

export function createSettingsFixtures(
  adapterType = "claude_local",
  outcome: TestOutcome = "pass",
  saveFails = false,
) {
  let agent: AgentDetail = {
    ...storybookHiredAgent,
    id: ID,
    urlKey: REF,
    name: "Nova",
    title: "Product engineer",
    role: "engineer",
    capabilities:
      "Build thoughtful product interfaces, investigate bugs, and verify changes in the browser.",
    adapterType: adapterType as AgentDetail["adapterType"],
    adapterConfig: {
      "access.MODEL_API": { type: "secret_ref", secretId: "secret-openai" },
    },
    runtimeConfig: {
      heartbeat: {
        enabled: true,
        intervalSec: 3600,
        wakeOnDemand: true,
        maxConcurrentRuns: 1,
      },
    },
    permissions: { canCreateAgents: false, canCreateSkills: true },
    chainOfCommand: [],
    access: {
      canAssignTasks: true,
      taskAssignSource: "explicit_grant",
      membership: null,
      grants: [],
    },
  };
  let desiredSkills = ["paperclip", "design-guide"];
  const files: Record<string, string> = {
    "AGENTS.md":
      "# Nova\n\nYou are a product engineer. Build interfaces that are clear, useful, and reliable.\n\n## Working style\n\n- Read the task and relevant code before making changes.\n- Keep changes focused and preserve existing behavior.\n- Test the experience in the browser before handing it back.\n\nRead [workflow.md](workflow.md) for your delivery checklist.\n",
    "workflow.md":
      "# Delivery checklist\n\n1. Understand the user’s goal.\n2. Make a focused change.\n3. Verify the result.\n4. Explain what changed and how it was tested.\n",
    "references/product.md":
      "# Product context\n\nPaperclip helps people coordinate teams of agents. Prefer simple workflows with visible progress.\n",
  };
  let bundleMode: "managed" | "external" = "managed";
  let entryFile = "AGENTS.md";
  const bundle = (): AgentInstructionsBundle => ({
    agentId: ID,
    companyId: COMPANY,
    mode: bundleMode,
    rootPath: `/managed/agents/${ID}`,
    managedRootPath: `/managed/agents/${ID}`,
    entryFile,
    resolvedEntryPath: `/managed/agents/${ID}/${entryFile}`,
    editable: true,
    warnings: [],
    legacyPromptTemplateActive: false,
    legacyBootstrapPromptTemplateActive: false,
    files: Object.entries(files).map(([path, content]) => ({
      path,
      size: content.length,
      language: "markdown",
      markdown: true,
      isEntryFile: path === entryFile,
      editable: true,
      deprecated: false,
      virtual: false,
    })),
  });
  const skills = (): AgentSkillSnapshot => ({
    adapterType: agent.adapterType,
    supported: true,
    mode: "ephemeral",
    desiredSkills,
    warnings: [],
    entries: desiredSkills.map((key) => ({
      key,
      runtimeName: key,
      desired: true,
      managed: true,
      state: "configured",
      origin: "company_managed",
      originLabel: "Managed by Paperclip",
      readOnly: false,
      sourcePath: `skills/${key}`,
      targetPath: null,
      detail: "Available on the next run.",
    })),
  });
  let secrets = [...storybookSecrets];
  let keys = [
    {
      id: "settings-key-1",
      name: "Automation",
      createdAt: new Date().toISOString(),
      revokedAt: null as string | null,
    },
  ];
  let revisions = [
    {
      id: "71c4f91a-initial",
      companyId: COMPANY,
      agentId: ID,
      createdByAgentId: null,
      createdByUserId: "user-board",
      source: "board",
      rolledBackFromRevisionId: null,
      changedKeys: ["adapterConfig", "runtimeConfig"],
      beforeConfig: {},
      afterConfig: { ...agent },
      createdAt: new Date().toISOString(),
    },
  ];
  let installs = [{ targetType: "agent", targetId: ID }];
  const connection = () => ({
    id: "settings-github",
    companyId: COMPANY,
    name: "GitHub",
    enabled: true,
    status: "active",
    transportType: "http",
    config: { sourceTemplateKey: "github" },
    transportConfig: { sourceTemplateKey: "github" },
    installs,
  });
  const catalog = [
    {
      id: "tool-read",
      connectionId: "settings-github",
      toolName: "get_repository",
      displayName: "Read repository",
      description: "Read repository contents and pull requests.",
      isReadOnly: true,
      isWrite: false,
      isDestructive: false,
      riskLevel: "low",
      status: "active",
    },
    {
      id: "tool-pr",
      connectionId: "settings-github",
      toolName: "create_pull_request",
      displayName: "Create pull request",
      description: "Open a pull request for review.",
      isReadOnly: false,
      isWrite: true,
      isDestructive: false,
      riskLevel: "medium",
      status: "active",
    },
  ];
  const recordRevision = (
    before: AgentDetail,
    patch: Record<string, unknown>,
  ) => {
    revisions.unshift({
      ...revisions[0],
      id: crypto.randomUUID(),
      changedKeys: Object.keys(patch).filter(
        (key) =>
          JSON.stringify(
            (before as unknown as Record<string, unknown>)[key],
          ) !== JSON.stringify(patch[key]),
      ),
      beforeConfig: { ...before },
      afterConfig: { ...agent },
      createdAt: new Date().toISOString(),
    });
  };
  return {
    get agent() {
      return agent;
    },
    install() {
      const previous = window.fetch;
      const handler: typeof fetch = async (input, init) => {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
          window.location.origin,
        );
        const method =
          init?.method ?? (input instanceof Request ? input.method : "GET");
        const payload = async () =>
          JSON.parse(
            typeof init?.body === "string"
              ? init.body
              : input instanceof Request
                ? await input.clone().text()
                : "{}",
          );
        const json = (value: unknown) => Response.json(value);
        if (url.pathname === "/api/instance/settings/experimental")
          return json({
            enableIsolatedWorkspaces: true,
            enableManagedSandboxOnly: false,
            enableEnvironments: true,
            enableNativeRunner: true,
          });
        if (url.pathname === "/api/instance/settings/general")
          return json({ executionMode: "any" });
        if (url.pathname === `/api/companies/${COMPANY}/environments`)
          return json(storybookEnvironments());
        if (url.pathname === `/api/companies/${COMPANY}/agents`)
          return json([...storybookAgents, agent]);
        if (url.pathname === `/api/companies/${COMPANY}/secrets`) {
          if (method === "POST") {
            const data = await payload();
            const secret = {
              ...storybookSecrets[0],
              id: `settings-secret-${secrets.length + 1}`,
              name: data.name,
              key: data.name.toLowerCase(),
              latestVersion: 1,
            };
            secrets.push(secret);
            return json(secret);
          }
          return json(secrets);
        }
        if (url.pathname === `/api/companies/${COMPANY}/skills`)
          return json(library);
        if (url.pathname.match(/\/adapters\/[^/]+\/models$/))
          return json(
            url.pathname.includes("claude")
              ? claudeModels
              : url.pathname.includes("codex") ||
                  url.pathname.includes("paperclip_runner")
                ? codexModels
                : url.pathname.includes("opencode")
                  ? openCodeModels
                  : [],
          );
        if (url.pathname.match(/\/adapters\/[^/]+\/test-environment$/)) {
          const data = await payload();
          await new Promise((resolve) => setTimeout(resolve, 1000));
          return json(
            runtimeTestResult(
              url.pathname.split("/").at(-2) ?? agent.adapterType,
              outcome,
              data.adapterConfig?.model ?? "",
              "Paperclip Computer",
            ),
          );
        }
        if (url.pathname === `/api/companies/${COMPANY}/tools/connections`)
          return json({ connections: [connection()] });
        if (url.pathname === `/api/companies/${COMPANY}/tools/policies`)
          return json({ policies: [] });
        if (url.pathname.includes("/tools/profiles/effective/agents/"))
          return json({
            profiles: [
              {
                id: "profile-engineering",
                name: "Engineering",
                summary: { isCompanyDefault: true },
              },
            ],
            entries: [{ effect: "include", connectionId: "settings-github" }],
            allowedTools: catalog,
          });
        if (url.pathname === "/api/tool-connections/settings-github/catalog")
          return json({ catalog });
        if (url.pathname === "/api/tool-connections/settings-github/grants")
          return json({ grants: [] });
        if (url.pathname === "/api/tool-connections/settings-github/installs") {
          if (method === "PUT") installs = (await payload()).installs;
          return json({ connectionId: "settings-github", installs });
        }
        if (
          url.pathname === `/api/companies/${COMPANY}/issues` &&
          method === "POST"
        ) {
          const data = await payload();
          return json({
            ...storybookIssues[0],
            ...data,
            id: "settings-task",
            identifier: "PAP-PREVIEW",
          });
        }
        const match = url.pathname.match(
          new RegExp(`^/api/agents/(?:${ID}|${REF})(/.*)?$`),
        );
        if (match) {
          const path = match[1] ?? "";
          if (method === "PATCH" && (path === "" || path === "/permissions")) {
            if (saveFails)
              return Response.json(
                { error: "Could not save changes. Please try again." },
                { status: 503 },
              );
            const patch = await payload();
            const before = agent;
            agent =
              path === "/permissions"
                ? {
                    ...agent,
                    permissions: { ...agent.permissions, ...patch },
                    access: {
                      ...agent.access!,
                      canAssignTasks:
                        patch.canAssignTasks ?? agent.access?.canAssignTasks,
                    },
                  }
                : { ...agent, ...patch };
            recordRevision(before, patch);
            return json(agent);
          }
          if (!path) return json(agent);
          if (path === "/skills/sync") {
            const data = await payload();
            desiredSkills = data.desiredSkills.map(
              (s: string | { key: string }) =>
                typeof s === "string" ? s : s.key,
            );
            return json(skills());
          }
          if (path === "/skills") return json(skills());
          if (path === "/instructions-bundle/file") {
            const path = url.searchParams.get("path") ?? "AGENTS.md";
            if (method === "DELETE") {
              delete files[path];
              return json(bundle());
            }
            const data = method === "PUT" ? await payload() : { path };
            if (method === "PUT") files[data.path] = data.content;
            return json({
              ...bundle().files.find((f) => f.path === data.path),
              content: files[data.path] ?? "",
            });
          }
          if (path === "/instructions-bundle") {
            if (method === "PATCH") {
              const data = await payload();
              bundleMode = data.mode ?? bundleMode;
              entryFile = data.entryFile ?? entryFile;
            }
            return json(bundle());
          }
          if (path === "/keys") {
            if (method === "POST") {
              const data = await payload();
              const key = {
                id: `settings-key-${keys.length + 1}`,
                name: data.name,
                createdAt: new Date().toISOString(),
                revokedAt: null,
              };
              keys.push(key);
              return json({
                ...key,
                token: "pcp_storybook_example_key_not_a_real_credential",
              });
            }
            return json(keys);
          }
          if (path.startsWith("/keys/") && method === "DELETE") {
            keys = keys.map((k) =>
              k.id === path.split("/").pop()
                ? { ...k, revokedAt: new Date().toISOString() }
                : k,
            );
            return json({ ok: true });
          }
          if (path.endsWith("/rollback")) {
            const revision = revisions.find((r) => path.includes(r.id));
            if (revision) {
              const before = agent;
              agent = { ...agent, ...revision.afterConfig };
              recordRevision(before, revision.afterConfig);
            }
            return json(agent);
          }
          if (path === "/config-revisions") return json(revisions);
          if (path === "/pause" || path === "/resume") {
            agent = { ...agent, status: path === "/pause" ? "paused" : "idle" };
            return json(agent);
          }
          if (path === "/runtime-state") return json(null);
          if (path === "/task-sessions" || path === "/heartbeat-runs")
            return json([]);
        }
        // Keep all other reads on Storybook's existing fixtures. Never send an
        // unhandled mutation outside this isolated preview.
        if (method !== "GET" && url.pathname.startsWith("/api/"))
          return Response.json(
            {
              error: "This action is not configured in this Storybook fixture.",
            },
            { status: 400 },
          );
        return previous(input, init);
      };
      window.fetch = handler;
      return () => {
        if (window.fetch === handler) window.fetch = previous;
      };
    },
  };
}
