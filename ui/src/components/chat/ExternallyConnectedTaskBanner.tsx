import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink, Radio } from "lucide-react";
import { chatEndpointsApi, type ChatProvider } from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/context/ToastContext";
import { Link } from "@/lib/router";

const providerNames: Record<ChatProvider, string> = {
  slack: "Slack",
  github: "GitHub",
  "microsoft-teams": "Microsoft Teams",
  telegram: "Telegram",
};

export function useIssueChatBinding(companyId: string, issueId: string) {
  const query = useQuery({
    queryKey: ["issue-chat-binding", companyId, issueId],
    queryFn: () => chatEndpointsApi.getIssueBinding(issueId),
    enabled: Boolean(companyId && issueId),
  });
  return { binding: query.data ?? null, isLoading: query.isLoading };
}

export function ExternallyConnectedTaskBanner({
  companyId,
  issueId,
}: {
  companyId: string;
  issueId: string;
}) {
  const { binding } = useIssueChatBinding(companyId, issueId);
  const { pushToast } = useToast();
  const [composing, setComposing] = useState(false);
  const [body, setBody] = useState("");
  const idempotencyKey = useRef<string | null>(null);
  const publish = useMutation({
    mutationFn: async (input: { body: string; idempotencyKey: string }) => {
      await chatEndpointsApi.publishBoardMessage(
        binding!.endpointId,
        binding!.conversationId,
        input.body,
        input.idempotencyKey,
      );
    },
    onSuccess: () => {
      idempotencyKey.current = null;
      setBody("");
      setComposing(false);
      pushToast({
        title: "Sent to channel",
        body: "The board update was published to the connected conversation.",
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: "Couldn't send to channel",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      }),
  });
  if (!binding) return null;
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <Radio className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            Connected to {providerNames[binding.provider]}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {binding.externalLabel} · Agent assignment is fixed for this
            external task.
          </p>
        </div>
        {binding.externalUrl && (
          <Button asChild size="sm" variant="outline">
            <a href={binding.externalUrl} target="_blank" rel="noreferrer">
              Open {providerNames[binding.provider]} <ExternalLink />
            </a>
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setComposing((value) => !value)}
        >
          Send to channel
        </Button>
        <Button asChild size="sm" variant="ghost">
          <Link to={`/apps/chat/${binding.endpointId}/conversations`}>
            Connection
          </Link>
        </Button>
      </div>
      {composing && (
        <div className="space-y-2 border-t border-border pt-3">
          <label
            className="text-xs font-medium"
            htmlFor="external-board-update"
          >
            Board update
          </label>
          <Textarea
            id="external-board-update"
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
              idempotencyKey.current = null;
            }}
            placeholder="Write only what should be visible in the provider conversation."
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Ordinary board comments remain Paperclip-only.
            </p>
            <Button
              size="sm"
              disabled={!body.trim() || publish.isPending}
              onClick={() => {
                idempotencyKey.current ??= crypto.randomUUID();
                publish.mutate({
                  body: body.trim(),
                  idempotencyKey: idempotencyKey.current,
                });
              }}
            >
              {publish.isPending ? "Sending…" : "Send to channel"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
