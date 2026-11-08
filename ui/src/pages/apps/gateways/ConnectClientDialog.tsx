import { Trans } from "@/i18n";
import { useTranslation } from "@/i18n";
import { type ComponentType, useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Braces,
  Check,
  Code2,
  Copy,
  HelpCircle,
  Link as LinkIcon,
  MousePointer2,
  TerminalSquare,
} from "lucide-react";
import type {
  ToolMcpGatewayClientSnippet,
  ToolMcpGatewayTokenCreated,
  ToolMcpGatewayWithTokens,
} from "@paperclipai/shared";
import { toolsApi } from "@/api/tools";
import { SearchableSelect, type SearchableSelectGroup } from "@/components/SearchableSelect";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/context/ToastContext";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import {
  defaultGatewayTokenName,
  formatHydratedSnippetConfig,
  maskedTokenLabel,
  orderedSnippets,
  tokenStatus,
} from "./gateway-helpers";
import { gatewaysQueryKey } from "./NewGatewayDialog";
import { describeError } from "@/api/errors";

type PanelKey = string;
type ClientIcon = ComponentType<{ className?: string }>;

const CLIENT_ICONS: Record<ToolMcpGatewayClientSnippet["client"], ClientIcon> = {
  cursor: MousePointer2,
  claude_desktop: Bot,
  vscode: Code2,
  claude_code: TerminalSquare,
  opencode: Braces,
};

type TokenOption = {
  key: string;
  value: string;
  label: string;
  title: string;
  searchText: string;
  token: ToolMcpGatewayTokenCreated;
};

export function ConnectClientDialog({
  gateway,
  open,
  onOpenChange,
  createdTokens,
  onTokenCreated,
}: {
  gateway: ToolMcpGatewayWithTokens;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  createdTokens: ToolMcpGatewayTokenCreated[];
  onTokenCreated: (token: ToolMcpGatewayTokenCreated) => void;
}) {
  const { t } = useTranslation("connections");
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const snippets = useMemo(() => orderedSnippets(gateway.clientSnippets ?? []), [gateway.clientSnippets, t]);
  const endpoint = useMemo(() => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}${gateway.endpointPath}`;
  }, [gateway.endpointPath, t]);

  const availableTokens = useMemo(
    () => createdTokens.filter((createdToken) => {
      const persisted = gateway.tokens.find((token) => token.id === createdToken.id);
      const status = tokenStatus(persisted ?? createdToken);
      return status === "active" || status === "expiring";
    }),
    [createdTokens, gateway.tokens, t],
  );
  const tokenGroups = useMemo<SearchableSelectGroup<string, TokenOption>[]>(() => [{
    id: "tokens",
    label: t("available_this_session_39d6d81"),
    options: availableTokens.map((token) => ({
      key: token.id,
      value: token.id,
      label: token.name,
      title: token.clientLabel,
      searchText: `${token.name} ${token.clientLabel} ${token.tokenPrefix}`,
      token,
    })),
  }], [availableTokens, t]);

  const [active, setActive] = useState<PanelKey>(snippets[0]?.client ?? "raw_url");
  const [selectedTokenId, setSelectedTokenId] = useState("");
  const selectedToken = availableTokens.find((token) => token.id === selectedTokenId) ?? null;

  useEffect(() => {
    if (!open) return;
    setActive(snippets[0]?.client ?? "raw_url");
    setSelectedTokenId((current) =>
      availableTokens.some((token) => token.id === current) ? current : availableTokens[0]?.id ?? "",
    );
  }, [availableTokens, open, snippets]);

  const issueTokenMutation = useMutation({
    mutationFn: () => {
      const name = defaultGatewayTokenName(gateway);
      return toolsApi.createGatewayToken(gateway.companyId, gateway.id, {
        name,
        clientLabel: name,
        ownerNote: "",
        allowedActions: ["tools/list", "tools/call"],
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      });
    },
    onSuccess: async (token) => {
      onTokenCreated(token);
      setSelectedTokenId(token.id);
      pushToast({
        title: t("token_issued_7007ea9"),
        body: t("the_copy_buttons_now_include_its_full_68015d8"),
        tone: "success",
      });
      await queryClient.invalidateQueries({ queryKey: gatewaysQueryKey(gateway.companyId) });
    },
    onError: (error) => pushToast({
      title: t("token_was_not_issued_7a7caf7"),
      body: describeError(error).body,
      tone: "error",
    }),
  });

  async function copyText(value: string, label: string) {
    try {
      await copyTextToClipboard(value);
      pushToast({ title: t("copied_8e3df45"), body: label, tone: "success" });
    } catch (error) {
      pushToast({
        title: t("copy_failed_bd5acbf"),
        body: describeError(error).body,
        tone: "error",
      });
    }
  }

  const activeSnippet = snippets.find((snippet) => snippet.client === active) ?? null;
  const displayConfigText = activeSnippet
    ? formatHydratedSnippetConfig(activeSnippet.config, {
        endpointPath: gateway.endpointPath,
        endpoint,
        token: selectedToken ? maskedTokenLabel(selectedToken) : t("pcgw_e82e344"),
      })
    : "";
  const copyConfigText = activeSnippet && selectedToken
    ? formatHydratedSnippetConfig(activeSnippet.config, {
        endpointPath: gateway.endpointPath,
        endpoint,
        token: selectedToken.token,
      })
    : null;

  function issueToken() {
    if (!issueTokenMutation.isPending) issueTokenMutation.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">{t("client_snippets_a8ebe47")}<Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-label={t("about_client_snippets_93ed4c8")} className="text-muted-foreground hover:text-foreground">
                  <HelpCircle className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-xs">{t("give_this_mcp_gateway_configuration_to_your_c31ee32")}</TooltipContent>
            </Tooltip>
          </DialogTitle>
          <DialogDescription>{t("choose_a_client_and_copy_a_complete_57bb853")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
          <span className="text-xs font-medium text-muted-foreground">Authorization</span>
          {availableTokens.length > 0 ? (
            <SearchableSelect<string, TokenOption>
              value={selectedTokenId}
              groups={tokenGroups}
              onValueChange={setSelectedTokenId}
              placeholder={t("issue_a_token_5b631a3")}
              searchPlaceholder={t("search_tokens_db6be2c")}
              emptyMessage={t("no_copyable_tokens_2b91aa3")}
              contentWidth="auto"
              triggerClassName="h-8 w-auto max-w-xs rounded-full px-3"
              renderValue={(option) => option ? `${option.label} · ${maskedTokenLabel(option.token)}` : "Issue a token"}
              renderOption={(option) => (
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{option.label}</span>
                  <span className="truncate font-mono text-(length:--text-micro) text-muted-foreground">
                    {maskedTokenLabel(option.token)}
                  </span>
                </span>
              )}
              createItem={{
                render: () => <span>{t("issue_a_new_token_a4597cb")}</span>,
                onSelect: issueToken,
              }}
            />
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-full"
              disabled={issueTokenMutation.isPending}
              onClick={issueToken}
            >
              {issueTokenMutation.isPending ? t("issuing_6bc09d8") : t("issue_a_token_5b631a3")}
            </Button>
          )}
          {selectedToken ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void copyText(`Authorization: Bearer ${selectedToken.token}`, "Authorization header")}
            >
              <Copy className="mr-1 h-3.5 w-3.5" />{t("copy_header_7bc09a2")}</Button>
          ) : null}
        </div>

        {!selectedToken ? (
          <p className="text-xs text-muted-foreground"><Trans ns="final-pages" i18nKey="Issue_a_token_before_copying_a_snippet_the_full_header_Authorizat_86373b" components={{ header: <code /> }} /></p>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-(--gtc-10)">
          <nav className="flex gap-1 overflow-x-auto sm:flex-col" aria-label={t("clients_28e22fe")}>
            {snippets.map((snippet) => {
              const Icon = CLIENT_ICONS[snippet.client];
              return (
                <button
                  key={snippet.client}
                  type="button"
                  onClick={() => setActive(snippet.client)}
                  className={cn(
                    "flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors",
                    active === snippet.client
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/60",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {snippet.label}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setActive("raw_url")}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors",
                active === "raw_url"
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              <LinkIcon className="h-4 w-4 shrink-0" />{t("raw_url_d8a3fa1")}</button>
          </nav>

          <div className="min-w-0 space-y-3">
            {active === "raw_url" ? (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <div className="text-sm font-medium text-foreground">{t("endpoint_url_65aaaa4")}</div>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
                      {endpoint}
                    </code>
                    <Button variant="outline" size="sm" onClick={() => void copyText(endpoint, "Endpoint URL")}>
                      <Copy className="mr-1 h-3.5 w-3.5" />{t("copy_7c39cf0")}</Button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <div className="text-sm font-medium text-foreground">{t("authorization_header_b4e71c8")}</div>
                  <code className="block truncate rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
                    {selectedToken ? `Authorization: Bearer ${maskedTokenLabel(selectedToken)}` : "Authorization: Bearer pcgw_•••"}
                  </code>
                </div>
              </div>
            ) : activeSnippet ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium text-foreground">{activeSnippet.label}</div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!copyConfigText}
                    onClick={() => copyConfigText && void copyText(copyConfigText, `${activeSnippet.label} config`)}
                  >
                    <Copy className="mr-1 h-3.5 w-3.5" />{t("copy_7c39cf0")}</Button>
                </div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs text-muted-foreground">
                  {displayConfigText}
                </pre>
                {activeSnippet.notes.length > 0 ? (
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {activeSnippet.notes.map((note) => <li key={note}>{note}</li>)}
                  </ul>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("no_client_snippets_available_for_this_gateway_2e468ed")}</p>
            )}

            <p className="text-xs text-muted-foreground">{t("treat_the_token_like_a_password_anyone_062ebfd")}</p>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>
            <Check className="mr-1.5 h-4 w-4" />{t("done_d588886")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
