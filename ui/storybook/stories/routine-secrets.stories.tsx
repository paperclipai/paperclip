import { useEffect, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import type {
  CompanySecret,
  EnvBinding,
  Routine,
  RoutineEnvConfig,
  RoutineRevision,
  RoutineRevisionSnapshotV1,
} from "@paperclipai/shared";
import { EnvVarEditor } from "@/components/EnvVarEditor";
import { RoutineHistoryTab } from "@/components/RoutineHistoryTab";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { storybookCompanies, storybookSecrets } from "../fixtures/paperclipData";

const COMPANY_ID = "company-storybook";

if (typeof window !== "undefined") {
  window.localStorage.setItem("paperclip.selectedCompanyId", COMPANY_ID);
}

function StorybookRoutineFixtures({
  revisions,
  children,
}: {
  revisions: RoutineRevision[];
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  queryClient.setQueryData(queryKeys.companies.all, { companies: storybookCompanies, unauthorized: false });
  queryClient.setQueryData(queryKeys.secrets.list(COMPANY_ID), storybookSecrets);
  queryClient.setQueryData(queryKeys.routines.revisions("routine-storybook"), revisions);

  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  useEffect(() => {
    if (selectedCompanyId !== COMPANY_ID) {
      setSelectedCompanyId(COMPANY_ID);
    }
  }, [selectedCompanyId, setSelectedCompanyId]);

  if (selectedCompanyId !== COMPANY_ID) return null;
  return <>{children}</>;
}

const meta: Meta = {
  title: "Product/Routines · Secrets tab",
  parameters: {
    layout: "fullscreen",
    a11y: { test: "off" },
  },
};

export default meta;

type Story = StoryObj;

function SecretsTabSurface({
  initial,
  title,
}: {
  initial: RoutineEnvConfig | null;
  title: string;
}) {
  const [env, setEnv] = useState<Record<string, EnvBinding>>(() => (initial ?? {}) as Record<string, EnvBinding>);
  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <KeyRound className="h-3.5 w-3.5" />
          {title}
        </CardTitle>
        <CardDescription className="text-xs">
          The Secrets tab on a routine reuses the env-var editor and adds a one-line precedence helper.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Routine secrets apply to every issue this routine creates. They override matching keys in
          project and agent env. <span className="font-mono">PAPERCLIP_*</span> variables are reserved.
        </p>
        <EnvVarEditor
          value={env}
          secrets={storybookSecrets as CompanySecret[]}
          onCreateSecret={async (name) => ({
            ...storybookSecrets[0]!,
            id: `secret-${Math.random().toString(36).slice(2, 8)}`,
            name,
            key: name.toLowerCase(),
            description: `New routine secret ${name}`,
          })}
          onChange={(next) => setEnv((next ?? {}) as Record<string, EnvBinding>)}
        />
      </CardContent>
    </Card>
  );
}

export const SecretsTabEmpty: Story = {
  render: () => (
    <div className="space-y-6 p-6">
      <SecretsTabSurface
        title="Empty — no routine secrets configured"
        initial={null}
      />
    </div>
  ),
};

export const SecretsTabConfigured: Story = {
  render: () => (
    <div className="space-y-6 p-6">
      <SecretsTabSurface
        title="Configured — mix of secret refs and plain values"
        initial={{
          OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-openai", version: "latest" },
          STAGE: { type: "plain", value: "production" },
          GH_TOKEN: { type: "secret_ref", secretId: "secret-aws-prod", version: 2 },
        }}
      />
    </div>
  ),
};

export const SecretsTabDisabledOrMissing: Story = {
  render: () => (
    <div className="space-y-6 p-6">
      <SecretsTabSurface
        title="Bindings need attention — disabled secret + missing secret"
        initial={{
          OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-openai", version: "latest" },
          GITHUB_APP_PEM: { type: "secret_ref", secretId: "secret-github", version: "latest" },
          ABANDONED: { type: "secret_ref", secretId: "missing-id", version: "latest" },
        }}
      />
    </div>
  ),
};

function makeSnapshot(env: RoutineEnvConfig | null): RoutineRevisionSnapshotV1 {
  return {
    version: 1,
    routine: {
      id: "routine-storybook",
      companyId: COMPANY_ID,
      projectId: null,
      goalId: null,
      parentIssueId: null,
      title: "Nightly digest",
      description: "Summarize agent activity each night.",
      assigneeAgentId: null,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      variables: [],
      env,
    },
    triggers: [],
  };
}

function makeRoutine(latestRevisionId: string, latestRevisionNumber: number): Routine {
  return {
    id: "routine-storybook",
    companyId: COMPANY_ID,
    projectId: null,
    goalId: null,
    parentIssueId: null,
    title: "Nightly digest",
    description: "Summarize agent activity each night.",
    assigneeAgentId: null,
    priority: "medium",
    status: "active",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    variables: [],
    env: makeSnapshot({
      OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-openai", version: "latest" },
      STAGE: { type: "plain", value: "production" },
    }).routine.env,
    latestRevisionId,
    latestRevisionNumber,
    createdByAgentId: null,
    createdByUserId: "user-board",
    updatedByAgentId: null,
    updatedByUserId: "user-board",
    lastTriggeredAt: null,
    lastEnqueuedAt: null,
    createdAt: new Date("2026-05-01T11:00:00.000Z"),
    updatedAt: new Date("2026-05-04T12:00:00.000Z"),
  };
}

export const HistoryDiffWithEnv: Story = {
  name: "History diff — env keys added/removed/changed",
  render: () => {
    const revisions: RoutineRevision[] = [
      {
        id: "rev-2",
        companyId: COMPANY_ID,
        routineId: "routine-storybook",
        revisionNumber: 2,
        title: "Nightly digest",
        description: "Summarize agent activity each night.",
        snapshot: makeSnapshot({
          OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-openai", version: "latest" },
          STAGE: { type: "plain", value: "production" },
        }),
        changeSummary: "Added STAGE plain value",
        restoredFromRevisionId: null,
        createdByAgentId: null,
        createdByUserId: "user-board",
        createdByRunId: null,
        createdAt: new Date("2026-05-04T12:00:00.000Z"),
      },
      {
        id: "rev-1",
        companyId: COMPANY_ID,
        routineId: "routine-storybook",
        revisionNumber: 1,
        title: "Nightly digest",
        description: "Summarize agent activity each night.",
        snapshot: makeSnapshot({
          OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-openai", version: 2 },
          GH_TOKEN: { type: "plain", value: "legacy" },
        }),
        changeSummary: "Created routine",
        restoredFromRevisionId: null,
        createdByAgentId: null,
        createdByUserId: "user-board",
        createdByRunId: null,
        createdAt: new Date("2026-05-01T11:00:00.000Z"),
      },
    ];
    return (
      <StorybookRoutineFixtures revisions={revisions}>
        <div className="space-y-6 p-6">
          <RoutineHistoryTab
            routine={makeRoutine("rev-2", 2)}
            isEditDirty={false}
            dirtyFields={[]}
            onDiscardEdits={() => {}}
            onSaveEdits={() => {}}
            agents={new Map()}
            projects={new Map()}
            secrets={storybookSecrets as CompanySecret[]}
            onRestoreSecretMaterials={() => {}}
          />
        </div>
      </StorybookRoutineFixtures>
    );
  },
};
