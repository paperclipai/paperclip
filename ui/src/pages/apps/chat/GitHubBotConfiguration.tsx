import { chatUiErrorMessage, type ChatUiError } from "./chat-copy";
import { t, useTranslation } from "@/i18n";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  GITHUB_REVIEW_EVENTS,
  type GitHubChatConfiguration,
  type GitHubReviewPolicy,
  type GitHubAllowedPerson,
} from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { githubChatApi } from "@/api/githubChat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Link } from "@/lib/router";

export const githubSelectClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
const eventLabels = {
  get opened() { return t("sep28Apps.copy4"); },
  get synchronize() { return t("sep28Apps.copy5"); },
  get reopened() { return t("sep28Apps.copy6"); },
  get ready_for_review() { return t("sep28Apps.copy7"); },
  get mention() { return t("sep28Apps.copy8"); },
  get comment() { return t("sep28Apps.copy9"); },
};
export function GitHubToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  useTranslation();
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {description && (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <ToggleSwitch
        aria-label={label}
        checked={checked}
        onCheckedChange={onChange}
      />
    </div>
  );
}
export function GitHubPolicyEditor({
  policy,
  onChange,
}: {
  policy: GitHubReviewPolicy;
  onChange: (policy: GitHubReviewPolicy) => void;
}) {
  useTranslation();
  const [prompt, setPrompt] =
    useState<(typeof GITHUB_REVIEW_EVENTS)[number]>("opened");
  const set = <K extends keyof GitHubReviewPolicy>(
    key: K,
    value: GitHubReviewPolicy[K],
  ) => onChange({ ...policy, [key]: value });
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="github-invocation">{t("sep28Apps.copy10")}</Label>
        <select
          id="github-invocation"
          className={githubSelectClass}
          value={policy.invocation}
          onChange={(e) =>
            set(
              "invocation",
              e.target.value as GitHubReviewPolicy["invocation"],
            )
          }
        >
          <option value="linked_authors">{t("sep28Apps.copy11")}</option>
          <option value="mentions_only">{t("sep28Apps.copy12")}</option>
          <option value="allowed_authors">{t("sep28Apps.copy13")}</option>
        </select>
        <p className="text-xs text-muted-foreground">{t("sep28Apps.copy14")}</p>
      </div>
      <div>
        <h3 className="text-sm font-medium">{t("sep28Apps.copy15")}</h3>
        {GITHUB_REVIEW_EVENTS.slice(0, 4).map((event) => (
          <GitHubToggle
            key={event}
            label={eventLabels[event]}
            checked={policy.events.includes(event)}
            onChange={(enabled) =>
              set(
                "events",
                enabled
                  ? [...new Set([...policy.events, event])]
                  : policy.events.filter((value) => value !== event),
              )
            }
          />
        ))}
        <GitHubToggle
          label={t("sep28Apps.copy16")}
          checked={policy.reviewDrafts}
          onChange={(value) => set("reviewDrafts", value)}
        />
        <GitHubToggle
          label={t("sep28Apps.copy17")}
          description={t("sep28Apps.copy18")}
          checked={policy.reviewBotAuthors}
          onChange={(value) => set("reviewBotAuthors", value)}
        />
      </div>
      <details className="rounded-lg border border-border p-4">
        <summary className="cursor-pointer text-sm font-medium">{t("sep28Apps.copy19")}</summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {(
            [
              [
                "includeAuthors",
                t("sep28Apps.copy20"),
                t("sep28Apps.copy21"),
              ],
              [
                "excludeAuthors",
                t("sep28Apps.copy22"),
                t("sep28Apps.copy23"),
              ],
              [
                "targetBranches",
                t("sep28Apps.copy24"),
                t("sep28Apps.copy25"),
              ],
              [
                "excludedBranches",
                t("sep28Apps.copy26"),
                t("sep28Apps.copy27"),
              ],
              [
                "requiredLabels",
                t("sep28Apps.copy28"),
                t("sep28Apps.copy29"),
              ],
              [
                "excludedLabels",
                t("sep28Apps.copy30"),
                t("sep28Apps.copy31"),
              ],
              [
                "ignoredPaths",
                t("sep28Apps.copy32"),
                t("sep28Apps.copy33"),
              ],
            ] as const
          ).map(([key, label, help]) => (
            <div className="space-y-2" key={key}>
              <Label htmlFor={`github-${key}`}>{label}</Label>
              <Textarea
                id={`github-${key}`}
                value={policy[key].join("\n")}
                onChange={(e) =>
                  set(key, e.target.value.split("\n").filter(Boolean))
                }
              />
              <p className="text-xs text-muted-foreground">{help}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{t("sep28Apps.copy34")}</p>
      </details>
      <div className="space-y-2">
        <Label htmlFor="github-instructions">{t("sep28Apps.copy35")}</Label>
        <Textarea
          id="github-instructions"
          value={policy.instructions}
          onChange={(e) => set("instructions", e.target.value)}
        />
        <p className="text-xs text-muted-foreground">{t("sep28Apps.copy36")}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="github-prompt-event">{t("sep28Apps.copy37")}</Label>
        <select
          id="github-prompt-event"
          className={githubSelectClass}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value as typeof prompt)}
        >
          {GITHUB_REVIEW_EVENTS.map((event) => (
            <option key={event} value={event}>
              {eventLabels[event]}
            </option>
          ))}
        </select>
        <Textarea
          aria-label={t("sep28Apps.eventPrompt", { event: eventLabels[prompt] })}
          value={policy.prompts[prompt]}
          onChange={(e) =>
            set("prompts", { ...policy.prompts, [prompt]: e.target.value })
          }
        />
        <p className="text-xs text-muted-foreground">{t("sep28Apps.copy38")}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="github-categories">{t("sep28Apps.copy39")}</Label>
          <Input
            id="github-categories"
            value={policy.findingCategories.join(", ")}
            onChange={(e) =>
              set(
                "findingCategories",
                e.target.value
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean),
              )
            }
          />
          <p className="text-xs text-muted-foreground">{t("sep28Apps.copy40")}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="github-severity">{t("sep28Apps.copy41")}</Label>
          <select
            id="github-severity"
            className={githubSelectClass}
            value={policy.minimumCommentSeverity}
            onChange={(e) =>
              set(
                "minimumCommentSeverity",
                e.target.value as GitHubReviewPolicy["minimumCommentSeverity"],
              )
            }
          >
            <option value="info">{t("status.info")}</option>
            <option value="warning">{t("status.warning")}</option>
            <option value="error">{t("status.error")}</option>
          </select>
          <p className="text-xs text-muted-foreground">{t("sep28Apps.copy42")}</p>
        </div>
      </div>
      <div>
        <h3 className="text-sm font-medium">{t("sep28Apps.copy43")}</h3>
        <GitHubToggle
          label={t("sep28Apps.copy44")}
          checked={policy.publishSummary}
          onChange={(value) => set("publishSummary", value)}
        />
        <GitHubToggle
          label={t("sep28Apps.copy45")}
          checked={policy.publishInline}
          onChange={(value) => set("publishInline", value)}
        />
        <GitHubToggle
          label={t("sep28Apps.copy46")}
          description={t("sep28Apps.copy47")}
          checked={policy.allowApprove}
          onChange={(value) => set("allowApprove", value)}
        />
        <GitHubToggle
          label={t("sep28Apps.copy48")}
          checked={policy.allowRequestChanges}
          onChange={(value) => set("allowRequestChanges", value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="github-rating">{t("sep28Apps.copy49")}</Label>
        <select
          id="github-rating"
          className={githubSelectClass}
          value={policy.ratingThreshold ?? "report"}
          onChange={(e) =>
            set(
              "ratingThreshold",
              e.target.value === "report"
                ? null
                : (Number(e.target.value) as 1 | 2 | 3 | 4 | 5),
            )
          }
        >
          {[5, 4, 3, 2, 1].map((score) => (
            <option key={score} value={score}>{t("sep28Apps.copy50")} {score}/5
            </option>
          ))}
          <option value="report">{t("sep28Apps.copy51")}</option>
        </select>
        <p className="text-xs text-muted-foreground">{t("sep28Apps.copy52")}</p>
        <a
          className="text-xs underline"
          href="https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository"
          target="_blank"
          rel="noreferrer"
        >{t("sep28Apps.copy53")}</a>
      </div>
    </div>
  );
}

export function GitHubAccessEditor({
  endpointId,
  companyId,
  configuration,
  onChange,
}: {
  endpointId: string;
  companyId: string;
  configuration: GitHubChatConfiguration;
  onChange: (configuration: GitHubChatConfiguration) => void;
}) {
  useTranslation();
  const accountLink = useRef<HTMLAnchorElement>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const members = useQuery({
    queryKey: ["github-members", companyId],
    queryFn: () => accessApi.listMembers(companyId),
  });
  const links = useQuery({
    queryKey: ["github-linked-members", endpointId],
    queryFn: () => chatEndpointsApi.listPrincipals(endpointId),
  });
  const [kind, setKind] = useState<"member" | "guest" | null>(null);
  const [login, setLogin] = useState("");
  const [sponsor, setSponsor] = useState(configuration.responsibleUserId);
  const [candidate, setCandidate] = useState<{
    githubUserId: string;
    login: string;
  } | null>(null);
  const [error, setError] = useState<ChatUiError>("");
  const [busy, setBusy] = useState(false);
  const add = (person: GitHubAllowedPerson) => {
    if (
      configuration.people.some((p) => p.githubUserId === person.githubUserId)
    )
      return;
    onChange({
      ...configuration,
      ...(person.kind === "member" ? { memberAccess: "selected" } : {}),
      people: [...configuration.people, person],
    });
    setKind(null);
    setCandidate(null);
    setLogin("");
  };
  const activeMembers = (members.data?.members ?? []).filter(
    (member) =>
      member.status === "active" && member.membershipRole !== "viewer",
  );
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="github-responsible">{t("sep28Apps.copy54")}</Label>
        <select
          id="github-responsible"
          className={githubSelectClass}
          value={configuration.responsibleUserId}
          onChange={(e) =>
            onChange({ ...configuration, responsibleUserId: e.target.value })
          }
        >
          {activeMembers.map((member) => (
            <option key={member.principalId} value={member.principalId}>
              {member.user?.name ?? member.user?.email ?? member.principalId}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">{t("sep28Apps.copy55")}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="github-member-access">{t("sep28Apps.copy56")}</Label>
        <select
          id="github-member-access"
          className={githubSelectClass}
          value={configuration.memberAccess}
          onChange={(e) =>
            onChange({
              ...configuration,
              memberAccess: e.target.value as "all_linked" | "selected",
            })
          }
        >
          <option value="all_linked">{t("sep28Apps.copy57")}</option>
          <option value="selected">{t("sep28Apps.copy58")}</option>
        </select>
        <p className="text-xs text-muted-foreground">{t("sep28Apps.copy59")}{" "}
          <Link
            className="underline"
            ref={accountLink}
            to={`/apps/chat/connect?provider=github&resume=${endpointId}&stage=identity`}
          >{t("sep28Apps.copy60")}</Link>
          <Button
            variant="link"
            size="sm"
            onClick={() => {
              if (accountLink.current)
                void copyTextToClipboard(accountLink.current.href).then(
                  () => setLinkCopied(true),
                  () =>
                    setError(
                      { key: "sep28Apps.copy61" },
                    ),
                );
            }}
          >
            {linkCopied ? t("common.linkCopied") : t("sep28Apps.copy62")}
          </Button>
          .
        </p>
      </div>
      <div className="space-y-3">
        <h3 className="text-sm font-medium">{t("sep28Apps.copy63")}</h3>
        {links.isError && (
          <p role="alert" className="text-sm text-destructive">{t("sep28Apps.copy64")}</p>
        )}
        {(links.data ?? [])
          .filter((link) => link.status === "linked")
          .map((link) => (
            <div
              key={link.principalId}
              className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
            >
              <p className="text-sm">
                @{link.githubLogin ?? link.externalLabel}
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await chatEndpointsApi.revokeLink(
                      endpointId,
                      link.principalId,
                    );
                    await links.refetch();
                  } catch (e) {
                    setError(
                      e instanceof Error
                        ? e.message
                        : { key: "sep28Apps.copy65" },
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >{t("sep28Apps.copy66")}</Button>
            </div>
          ))}
        {!links.isPending &&
          !links.isError &&
          !(links.data ?? []).some((link) => link.status === "linked") && (
            <p className="text-sm text-muted-foreground">{t("sep28Apps.copy67")}</p>
          )}
      </div>
      <div className="divide-y divide-border rounded-lg border border-border">
        {configuration.people.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">{t("sep28Apps.copy68")}</p>
        )}
        {configuration.people.map((person) => (
          <div key={person.githubUserId} className="space-y-2 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">@{person.login}</p>
                <p className="text-xs text-muted-foreground">
                  {person.kind === "member"
                    ? t("sep28Apps.copy69")
                    : t("sep28Apps.copy70")}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  onChange({
                    ...configuration,
                    people: configuration.people.filter(
                      (p) => p.githubUserId !== person.githubUserId,
                    ),
                  })
                }
              >{t("pages.profile.remove")}</Button>
            </div>
            <GitHubToggle
              label={t("sep28Apps.automaticPerson", { login: person.login })}
              checked={person.automaticReviews}
              onChange={(value) =>
                onChange({
                  ...configuration,
                  people: configuration.people.map((p) =>
                    p.githubUserId === person.githubUserId
                      ? { ...p, automaticReviews: value }
                      : p,
                  ),
                })
              }
            />
            {person.kind === "guest" && (
              <p className="text-xs text-muted-foreground">
                {t("sep28Apps.sponsorNotice", { sponsor: activeMembers.find((member) => member.principalId === person.sponsorUserId)?.user?.name ?? person.sponsorUserId })}
              </p>
            )}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setKind("member")}>{t("sep28Apps.copy72")}</Button>
        <Button variant="outline" onClick={() => setKind("guest")}>{t("sep28Apps.copy73")}</Button>
      </div>
      {kind === "member" && (
        <div className="space-y-3 rounded-lg border border-border p-4">
          <p className="text-sm">{t("sep28Apps.copy74")}</p>
          {(links.data ?? [])
            .filter((link) => link.status === "linked" && link.paperclipUserId)
            .map((link) => (
              <Button
                className="mr-2"
                key={link.id}
                variant="outline"
                disabled={configuration.people.some(
                  (p) =>
                    p.kind === "member" && p.userId === link.paperclipUserId,
                )}
                onClick={() => {
                  const id = link.githubUserId;
                  if (!id) {
                    setError(
                      { key: "sep28Apps.copy75" },
                    );
                    return;
                  }
                  add({
                    kind: "member",
                    userId: link.paperclipUserId!,
                    githubUserId: id,
                    login: link.githubLogin ?? link.externalLabel,
                    automaticReviews: false,
                  });
                }}
              >
                {link.paperclipUserLabel ?? link.externalLabel}
              </Button>
            ))}
          <Button variant="ghost" onClick={() => setKind(null)}>{t("pages.cliAuth.cancel")}</Button>
        </div>
      )}
      {kind === "guest" && (
        <div className="space-y-4 rounded-lg border border-border p-4">
          <p className="text-sm">{t("sep28Apps.copy76")}</p>
          <div className="space-y-2">
            <Label htmlFor="github-guest-login">{t("sep28Apps.copy77")}</Label>
            <div className="flex gap-2">
              <Input
                id="github-guest-login"
                value={login}
                onChange={(e) => {
                  setLogin(e.target.value);
                  setCandidate(null);
                }}
              />
              <Button
                variant="outline"
                disabled={busy || !login}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    setCandidate(await githubChatApi.lookup(endpointId, login));
                  } catch (error) {
                    setError(
                      error instanceof Error ? error.message : { key: "sep28Apps.copy78" },
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >{t("sep28Apps.copy79")}</Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="github-guest-sponsor">{t("sep28Apps.copy71")}</Label>
            <select
              id="github-guest-sponsor"
              className={githubSelectClass}
              value={sponsor}
              onChange={(e) => setSponsor(e.target.value)}
            >
              {activeMembers.map((member) => (
                <option key={member.principalId} value={member.principalId}>
                  {member.user?.name ?? member.principalId}
                </option>
              ))}
            </select>
          </div>
          {candidate && (
            <p className="text-sm">
              @{candidate.login} · GitHub ID {candidate.githubUserId}
            </p>
          )}
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setKind(null)}>{t("pages.cliAuth.cancel")}</Button>
            <Button
              disabled={
                !candidate ||
                !sponsor ||
                configuration.people.some(
                  (p) => p.githubUserId === candidate.githubUserId,
                )
              }
              onClick={() =>
                candidate &&
                add({
                  ...candidate,
                  kind: "guest",
                  sponsorUserId: sponsor,
                  permissionProfile: "restricted",
                  automaticReviews: false,
                })
              }
            >{t("sep28Apps.copy80")}</Button>
          </div>
        </div>
      )}
      {(error || members.error || links.error) && (
        <p role="alert" className="text-sm text-destructive">
          {chatUiErrorMessage(error) ||
            t("sep28Apps.copy81")}
        </p>
      )}
    </div>
  );
}
