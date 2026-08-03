import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { ProjectProperties, type ProjectConfigFieldKey, type ProjectFieldSaveState } from "@/components/ProjectProperties";
import { queryKeys } from "@/lib/queryKeys";
import { storybookProjects } from "../fixtures/paperclipData";

const COMPANY_ID = "company-storybook";
const boardProject = storybookProjects.find((project) => project.id === "project-board-ui") ?? storybookProjects[0]!;

function fieldState(field: ProjectConfigFieldKey): ProjectFieldSaveState {
  return field === "execution_workspace_runtime_provision_command" ? "saved" : "idle";
}

function Hydrate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  useState(() => {
    queryClient.setQueryData(queryKeys.instance.experimentalSettings, {
      enableIsolatedWorkspaces: true,
      enableRoutineTriggers: true,
      enableEnvironments: false,
    });
    queryClient.setQueryData(queryKeys.secrets.list(COMPANY_ID), []);
    return true;
  });
  return children;
}

const meta: Meta<typeof ProjectProperties> = {
  title: "Workspaces/Project runtime provision command",
  component: ProjectProperties,
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof ProjectProperties>;

const editableProject: Project = {
  ...boardProject,
  env: null,
};

export const IsolatedStrategy: Story = {
  name: "Isolated workspace strategy (advanced open)",
  render: () => (
    <Hydrate>
      <div className="max-w-2xl rounded-lg border border-border bg-background p-4">
        <ProjectProperties
          project={editableProject}
          onFieldUpdate={() => undefined}
          getFieldSaveState={fieldState}
          onArchive={() => undefined}
        />
      </div>
    </Hydrate>
  ),
};
