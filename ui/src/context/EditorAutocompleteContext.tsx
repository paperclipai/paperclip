import { createContext, useContext, useMemo, type ReactNode } from "react";
import { QueryClientContext, useQuery } from "@tanstack/react-query";
import { buildRoutineMentionHref, buildSkillMentionHref } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { companySkillsApi } from "../api/companySkills";
import { routinesApi } from "../api/routines";
import { useOptionalCompany } from "./CompanyContext";
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

/**
 * A chat/slash command advertised by the issue assignee's adapter (Codex
 * `/goal`, etc.). Unlike skills/routines these insert as literal `/name` text
 * so the server's leading-slash command router recognizes them — they are NOT
 * rendered as mention links. Only commands the assignee can actually honor are
 * listed (the adapter capability endpoint returns `[]` otherwise), so a
 * non-goal agent simply shows no `/goal` entry.
 */
export interface ChatCommandOption {
  id: string;
  kind: "chat-command";
  name: string;
  argHint: string | null;
  description: string;
  aliases: string[];
}

export type SlashCommandOption = SkillCommandOption | RoutineCommandOption | ChatCommandOption;

interface EditorAutocompleteContextValue {
  slashCommands: SlashCommandOption[];
}

const EMPTY_EDITOR_AUTOCOMPLETE_VALUE: EditorAutocompleteContextValue = {
  slashCommands: [],
};
const EditorAutocompleteContext = createContext<EditorAutocompleteContextValue>(EMPTY_EDITOR_AUTOCOMPLETE_VALUE);

interface EditorAutocompleteProviderProps {
  children: ReactNode;
  /**
   * When set, the assignee agent's advertised chat commands (e.g. Codex
   * `/goal`) are added to the autocomplete. Used by the issue-thread composer
   * so `/` lists commands addressed to the issue's assignee.
   */
  assigneeAgentId?: string | null;
  /** Explicit company scope for provider-less embedded and test surfaces. */
  companyId?: string | null;
}

export function EditorAutocompleteProvider({
  children,
  assigneeAgentId = null,
  companyId = null,
}: EditorAutocompleteProviderProps) {
  const queryClient = useContext(QueryClientContext);
  if (!queryClient) {
    return (
      <EditorAutocompleteContext.Provider value={EMPTY_EDITOR_AUTOCOMPLETE_VALUE}>
        {children}
      </EditorAutocompleteContext.Provider>
    );
  }

  return (
    <EditorAutocompleteQueries
      assigneeAgentId={assigneeAgentId}
      companyId={companyId}
    >
      {children}
    </EditorAutocompleteQueries>
  );
}

function EditorAutocompleteQueries({
  children,
  assigneeAgentId = null,
  companyId = null,
}: EditorAutocompleteProviderProps) {
  const company = useOptionalCompany();
  const selectedCompanyId = companyId ?? company?.selectedCompanyId ?? null;
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
  const { data: chatCommands = [] } = useQuery({
    queryKey: assigneeAgentId
      ? queryKeys.agents.chatCommands(assigneeAgentId)
      : ["agents", "chat-commands", "__none__"],
    queryFn: () => agentsApi.listChatCommands(assigneeAgentId!, selectedCompanyId ?? undefined),
    enabled: Boolean(assigneeAgentId),
  });

  const value = useMemo<EditorAutocompleteContextValue>(() => ({
    slashCommands: [
      // Assignee chat commands lead the list so `/goal` is the first, most
      // prominent suggestion when a goal-enabled agent is addressed.
      ...chatCommands.map((command) => ({
        id: `chat-command:${command.name}`,
        kind: "chat-command" as const,
        name: command.name,
        argHint: command.argHint ?? null,
        description: command.description,
        aliases: [command.name, `/${command.name}`],
      })),
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
    ],
  }), [chatCommands, companySkills, routines]);

  return (
    <EditorAutocompleteContext.Provider value={value}>
      {children}
    </EditorAutocompleteContext.Provider>
  );
}

export function useEditorAutocomplete() {
  return useContext(EditorAutocompleteContext);
}
