import path from "node:path";
import { FixtureRegistry } from "./fixture-registry.js";
import type { RunnerApi } from "./api.js";
import type {
  CredentialName,
  MatrixExecution,
  SecretReference,
  SecretReferenceMap,
} from "./types.js";

interface CompanyRecord {
  id: string;
  issuePrefix?: string | null;
  name: string;
}

interface SecretRecord {
  id: string;
}
interface PluginRecord {
  id: string;
  pluginKey: string;
  status: string;
}
interface EnvironmentRecord {
  id: string;
  driver: string;
  config?: Record<string, unknown>;
}
interface AgentRecord {
  id: string;
  name: string;
  companyId: string;
}
interface ProjectRecord {
  id: string;
  name: string;
  primaryWorkspace?: {
    id: string;
    cwd?: string | null;
  } | null;
}

export interface LiveFixtureValues {
  company: CompanyRecord;
  secretRefs: SecretReferenceMap;
  environment: EnvironmentRecord;
  agent: AgentRecord;
  project?: ProjectRecord;
  teardown(): Promise<void>;
}

function value<T>(resolved: ReadonlyMap<string, unknown>, id: string): T {
  const result = resolved.get(id);
  if (!result) throw new Error(`Missing resolved fixture ${id}`);
  return result as T;
}

async function deleteDaytonaEnvironment(api: RunnerApi, environmentId: string) {
  const deadlineAt = Date.now() + 120_000;
  let lastError: unknown;
  while (Date.now() < deadlineAt) {
    try {
      await api.delete(
        `/api/environments/${environmentId}?destroyReusableSandboxLeases=true`,
        {
          allowNotFound: true,
        },
      );
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
  throw new Error(
    `Daytona lease cleanup failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export async function setupLiveFixtures(input: {
  api: RunnerApi;
  execution: MatrixExecution;
  executionNonce: string;
  workspacePath: string;
  credentials: Partial<Record<CredentialName, string>>;
  daytonaImage?: string;
}): Promise<LiveFixtureValues> {
  const { api, execution } = input;
  const registry = new FixtureRegistry();

  if (execution.environment.id === "daytona") {
    registry.register<PluginRecord>({
      id: "sandbox-provider",
      async setup() {
        return api.post<PluginRecord>("/api/plugins/install", {
          packageName: path.resolve(
            import.meta.dirname,
            "../../packages/plugins/sandbox-providers/daytona",
          ),
          isLocalPath: true,
        });
      },
      async teardown() {
        // The plugin is installed only in the isolated instance/database. The
        // launcher removes that complete instance after the environment lease
        // has been destroyed, so no global uninstall mutation is necessary.
      },
    });
  }

  registry.register<CompanyRecord>({
    id: "company",
    async setup() {
      return api.post<CompanyRecord>("/api/companies", {
        name: `Runner E2E ${execution.id} ${input.executionNonce}`,
        description: "Ephemeral paid full-stack runner acceptance fixture",
        budgetMonthlyCents: 0,
      });
    },
    async teardown() {
      // The isolated instance/database is removed by the launcher. Do not call
      // company deletion here: metered runs intentionally retain cost-event
      // references until that instance-wide teardown.
    },
  });

  registry.register<SecretReferenceMap>({
    id: "secrets",
    dependencies: ["company"],
    async setup(resolved) {
      const company = value<CompanyRecord>(resolved, "company");
      const refs: SecretReferenceMap = {};
      for (const credentialName of execution.requiredCredentials) {
        const rawValue = input.credentials[credentialName];
        if (!rawValue) throw new Error(`Missing credential ${credentialName}`);
        const secret = await api.postSensitive<SecretRecord>(
          `/api/companies/${company.id}/secrets`,
          {
            name: `Runner E2E ${credentialName} ${input.executionNonce}`,
            key: credentialName,
            value: rawValue,
            description: `Ephemeral credential for ${execution.id}`,
          },
        );
        refs[credentialName] = {
          type: "secret_ref",
          secretId: secret.id,
          version: "latest",
        } satisfies SecretReference;
      }
      return refs;
    },
  });

  registry.register<EnvironmentRecord>({
    id: "environment",
    dependencies: [
      "company",
      "secrets",
      ...(execution.environment.id === "daytona" ? ["sandbox-provider"] : []),
    ],
    async setup(resolved) {
      const company = value<CompanyRecord>(resolved, "company");
      const secretRefs = value<SecretReferenceMap>(resolved, "secrets");
      if (execution.environment.id === "local") {
        // Paperclip has one instance-managed local environment. The company
        // creation API ensures it exists; creating a second local environment
        // is intentionally rejected by the public API.
        const environments = await api.get<EnvironmentRecord[]>(
          `/api/companies/${company.id}/environments?driver=local`,
        );
        const local = environments.find(
          (candidate) => candidate.driver === "local",
        );
        if (!local)
          throw new Error(
            "Isolated Paperclip instance did not create its managed local environment",
          );
        return local;
      }
      return api.post<EnvironmentRecord>(
        `/api/companies/${company.id}/environments`,
        execution.environment.buildEnvironment({
          secretRefs,
          daytonaImage: input.daytonaImage,
          executionId: input.executionNonce,
        }),
      );
    },
    async teardown(environment) {
      if (execution.environment.id === "daytona") {
        await deleteDaytonaEnvironment(api, environment.id);
      }
    },
  });

  registry.register<AgentRecord>({
    id: "agent",
    dependencies: ["company", "secrets", "environment"],
    async setup(resolved) {
      const company = value<CompanyRecord>(resolved, "company");
      const environment = value<EnvironmentRecord>(resolved, "environment");
      const secretRefs = value<SecretReferenceMap>(resolved, "secrets");
      return api.post<AgentRecord>(
        `/api/companies/${company.id}/agents`,
        execution.profile.buildAgent({
          environmentId: environment.id,
          environmentFixtureId: execution.environment.id,
          workspacePath: input.workspacePath,
          secretRefs,
          executionId: input.executionNonce,
        }),
      );
    },
    async teardown() {
      // Agent state is instance-local. Daytona environment teardown below is
      // the only fixture cleanup that must reach an external provider.
    },
  });

  if (execution.environment.configurationKey === "warm-reuse-v1") {
    registry.register<ProjectRecord>({
      id: "project",
      dependencies: ["company", "environment"],
      async setup(resolved) {
        const company = value<CompanyRecord>(resolved, "company");
        const environment = value<EnvironmentRecord>(resolved, "environment");
        return api.post<ProjectRecord>(
          `/api/companies/${company.id}/projects`,
          {
            name: `Runner E2E warm project ${input.executionNonce}`,
            description:
              "Ephemeral project anchoring a reusable Daytona execution workspace",
            executionWorkspacePolicy: {
              enabled: true,
              defaultMode: "shared_workspace",
              sharedWorkspaceConcurrency: "serialize",
              allowIssueOverride: false,
              environmentId: environment.id,
              workspaceStrategy: { type: "project_primary" },
            },
            workspace: {
              name: "Primary",
              sourceType: "local_path",
              cwd: input.workspacePath,
              isPrimary: true,
            },
          },
        );
      },
      async teardown() {
        // The isolated instance is deleted after provider resources are gone.
      },
    });
  }

  const setup = await registry.setupAll();
  return {
    company: value<CompanyRecord>(setup.values, "company"),
    secretRefs: value<SecretReferenceMap>(setup.values, "secrets"),
    environment: value<EnvironmentRecord>(setup.values, "environment"),
    agent: value<AgentRecord>(setup.values, "agent"),
    ...(setup.values.has("project")
      ? { project: value<ProjectRecord>(setup.values, "project") }
      : {}),
    teardown: setup.teardown,
  };
}
