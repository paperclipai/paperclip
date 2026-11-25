import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { X } from "lucide-react";
import { authApi } from "@/api/auth";
import { describeError } from "@/api/errors";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import type { ComposerRunSettings } from "@/components/task-chat/composer-run-settings";
import { useStartAgentChat } from "@/hooks/useAgentChatNavigation";
import { agentIdFromChatValue, chatAgentOptions, defaultChatAgent } from "@/lib/dashboard-chat";
import { queryKeys } from "@/lib/queryKeys";
import { getRecentAssigneeIds, trackRecentAssignee } from "@/lib/recent-assignees";
import { Link } from "@/lib/router";

/** Below the app's mobile breakpoint the composer uses its mobile sizing (16px text, so iOS does not zoom). */
const MOBILE_QUERY = "(max-width: 767px)";

function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(MOBILE_QUERY).matches);
  useEffect(() => {
    const list = window.matchMedia?.(MOBILE_QUERY);
    if (!list) return;
    const update = () => setNarrow(list.matches);
    list.addEventListener?.("change", update);
    return () => list.removeEventListener?.("change", update);
  }, []);
  return narrow;
}

interface StagedFile {
  id: string;
  file: File;
}

/**
 * "Start a chat" at the foot of the Dashboard: the app's task composer, with
 * its agent picker, starting on the first agent created in the organization.
 * Enter sends: the chat with the chosen agent is opened (one per agent), the
 * text is its first message, and the page moves to that conversation in Chat.
 * A failed send keeps the text and says why. With no agents, one quiet line.
 */
export function DashboardChatComposer({
  companyId,
  agents,
  loaded,
}: {
  companyId: string;
  agents: readonly Agent[];
  /** False until the company's agents have loaded: nothing shows before then. */
  loaded: boolean;
}) {
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  const userId = session.data?.user?.id ?? session.data?.session?.userId ?? null;
  const startChat = useStartAgentChat(companyId, userId);
  const mobile = useNarrowViewport();
  const recentIds = useMemo(() => getRecentAssigneeIds(), []);
  const options = useMemo(() => chatAgentOptions(agents, recentIds), [agents, recentIds]);
  const fallback = useMemo(() => defaultChatAgent(agents), [agents]);
  const modelAgents = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const [chosen, setChosen] = useState<string | null>(null);
  const value = chosen && options.some((option) => option.id === chosen) ? chosen : fallback ? `agent:${fallback.id}` : "";
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [runSettings, setRunSettings] = useState<ComposerRunSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The same message to the same agent keeps its request id, so a retry after
  // an uncertain failure is recognised by the server instead of sent twice.
  const request = useRef<{ key: string; id: string } | null>(null);

  const submit = useCallback(
    async (text: string, _mode: unknown, settings: ComposerRunSettings | null) => {
      const agent = agents.find((candidate) => candidate.id === agentIdFromChatValue(value));
      if (!agent) {
        setError("Choose an agent to talk to.");
        return;
      }
      const key = `${agent.id}\n${text}\n${files.map((staged) => staged.id).join(",")}`;
      if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
      setError(null);
      try {
        await startChat({ agent, body: text, files: files.map((staged) => staged.file), runSettings: settings, clientRequestId: request.current.id });
        request.current = null;
        setBody("");
        setFiles([]);
      } catch (failure) {
        setError(`Couldn’t start the chat with ${agent.name}. ${describeError(failure).body}`);
      }
    },
    [agents, files, startChat, value],
  );

  if (!loaded) return null;
  if (options.length === 0) {
    return (
      <p className="mx-auto w-full max-w-(--tc-shell-max-w) text-sm text-muted-foreground" data-dashboard-chat="no-agents">
        <Link to="/agents/new" className="underline underline-offset-4 hover:text-foreground">Add an agent</Link> to start a chat from here.
      </p>
    );
  }

  const images = files.filter((staged) => staged.file.type.startsWith("image/"));
  const others = files.filter((staged) => !staged.file.type.startsWith("image/"));
  const removeFile = (id: string) => setFiles((current) => current.filter((staged) => staged.id !== id));

  return (
    <div className="mx-auto w-full max-w-(--tc-shell-max-w)" data-dashboard-chat="">
      <TaskChatComposer
        workMode="standard"
        mobile={mobile}
        companyId={companyId}
        enableReassign
        reassignOptions={options}
        modelAgents={modelAgents}
        agentMap={modelAgents}
        currentAssigneeValue={value}
        onPendingAssigneeChange={(next) => {
          if (next === null) return;
          const agentId = agentIdFromChatValue(next);
          if (agentId) trackRecentAssignee(agentId, companyId);
          setChosen(next);
          setRunSettings(null);
          setError(null);
        }}
        creation={{
          value: body,
          onChange: (next) => {
            setBody(next);
            if (error) setError(null);
          },
          onSubmit: submit,
          submitLabel: "Send",
          onSelectFiles: (picked) => setFiles((current) => [...current, ...picked.map((file) => ({ id: crypto.randomUUID(), file }))]),
          images: images.map((staged) => ({ id: staged.id, name: staged.file.name, file: staged.file })),
          onRemoveImage: removeFile,
          runSettings,
          onRunSettingsChange: setRunSettings,
          header: error ? (
            <p role="alert" className="mb-2 text-sm text-destructive">{error}</p>
          ) : null,
          details: others.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-2">
              {others.map((staged) => (
                <li key={staged.id} className="flex max-w-full items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-foreground">
                  <span className="truncate">{staged.file.name}</span>
                  <button
                    type="button"
                    className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Remove ${staged.file.name}`}
                    onClick={() => removeFile(staged.id)}
                  >
                    <X aria-hidden="true" className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null,
        }}
      />
    </div>
  );
}
