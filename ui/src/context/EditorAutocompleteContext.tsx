import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { buildPipelineMentionHref, buildRoutineMentionHref, buildSkillMentionHref } from "@paperclipai/shared";
import { companySkillsApi } from "../api/companySkills";
import { pipelinesApi, type PipelineStage } from "../api/pipelines";
import { instanceSettingsApi } from "../api/instanceSettings";
import { routinesApi } from "../api/routines";
import { useCompany } from "./CompanyContext";
import { queryKeys } from "../lib/queryKeys";

export interface SkillCommandOption {
  id: string;
  kind: "skill";
  skillId: string;
  key: string;
  name: string;
  slug: string;
  description: string | null;
  href: string;
  aliases: string[];
}

export interface RoutineCommandOption {
  id: string;
  kind: "routine";
  routineId: string;
  name: string;
  status: string;
  href: string;
  aliases: string[];
}

export interface PipelineCommandOption {
  id: string;
  kind: "pipeline";
  pipelineId: string;
  stageKey: string | null;
  name: string;
  key: string;
  stageName: string | null;
  href: string;
  aliases: string[];
}

export type SlashCommandOption = SkillCommandOption | RoutineCommandOption | PipelineCommandOption;

interface EditorAutocompleteContextValue {
  slashCommands: SlashCommandOption[];
}

const EditorAutocompleteContext = createContext<EditorAutocompleteContextValue>({
  slashCommands: [],
});

export function EditorAutocompleteProvider({ children }: { children: ReactNode }) {
  const { selectedCompanyId } = useCompany();
  const { data: companySkills = [] } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.companySkills.list(selectedCompanyId)
      : ["company-skills", "__none__"],
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const { data: routines = [] } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.routines.list(selectedCompanyId)
      : ["routines", "__none__", "__all-projects__"],
    queryFn: () => routinesApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const pipelinesEnabled = experimentalSettings?.enablePipelines === true;
  const { data: pipelines = [] } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.pipelines.list(selectedCompanyId)
      : ["pipelines", "__none__"],
    queryFn: () => pipelinesApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && pipelinesEnabled,
  });

  const value = useMemo<EditorAutocompleteContextValue>(() => ({
    slashCommands: [
      ...companySkills.map((skill) => ({
        id: `skill:${skill.id}`,
        kind: "skill" as const,
        skillId: skill.id,
        key: skill.key,
        name: skill.name,
        slug: skill.slug,
        description: skill.description ?? null,
        href: buildSkillMentionHref(skill.id, skill.slug),
        aliases: [skill.slug, skill.name, skill.key],
      })),
      ...routines
        .filter((routine) => routine.status !== "archived")
        .sort((left, right) => left.title.localeCompare(right.title))
        .map((routine) => ({
          id: `routine:${routine.id}`,
          kind: "routine" as const,
          routineId: routine.id,
          name: routine.title,
          status: routine.status,
          href: buildRoutineMentionHref(routine.id),
          aliases: [`routine:${routine.title}`, routine.title, routine.id],
        })),
      ...(pipelinesEnabled ? pipelines : [])
        .filter((pipeline) => !pipeline.archivedAt)
        .sort((left, right) => left.name.localeCompare(right.name))
        .flatMap((pipeline) => {
          const base: PipelineCommandOption = {
            id: `pipeline:${pipeline.id}`,
            kind: "pipeline",
            pipelineId: pipeline.id,
            stageKey: null,
            name: pipeline.name,
            key: pipeline.key,
            stageName: null,
            href: buildPipelineMentionHref(pipeline.id),
            aliases: [
              `pipeline:${pipeline.name}`,
              `pipeline:${pipeline.key}`,
              pipeline.name,
              pipeline.key,
              pipeline.id,
            ],
          };
          const stages = Array.isArray((pipeline as { stages?: PipelineStage[] }).stages)
            ? (pipeline as { stages?: PipelineStage[] }).stages ?? []
            : [];
          return [
            base,
            ...stages.map((stage) => ({
              id: `pipeline:${pipeline.id}:${stage.key}`,
              kind: "pipeline" as const,
              pipelineId: pipeline.id,
              stageKey: stage.key,
              name: pipeline.name,
              key: pipeline.key,
              stageName: stage.name,
              href: buildPipelineMentionHref(pipeline.id, stage.key),
              aliases: [
                `pipeline:${pipeline.name} ${stage.name}`,
                `pipeline:${pipeline.key} ${stage.key}`,
                `${pipeline.name} ${stage.name}`,
                `${pipeline.key} ${stage.key}`,
                pipeline.id,
              ],
            })),
          ];
        }),
    ],
  }), [companySkills, pipelines, pipelinesEnabled, routines]);

  return (
    <EditorAutocompleteContext.Provider value={value}>
      {children}
    </EditorAutocompleteContext.Provider>
  );
}

export function useEditorAutocomplete() {
  return useContext(EditorAutocompleteContext);
}
