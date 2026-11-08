import { t as finalPagesT } from "@/i18n";
import { useTranslation, t as translate } from "@/i18n";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import {
  GITHUB_REVIEW_EVENTS,
  type GitHubChatConfiguration,
  type GitHubReviewPolicy,
  type GitHubAllowedPerson,
} from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { githubChatApi } from "@/api/githubChat";
import { useOptionalCompany } from "@/context/CompanyContext";
import { Button } from "@/components/ui/button";
import {
  AtSign,
  Check,
  Copy,
  HelpCircle,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { GitHubSettingsDisclosure } from "./GitHubSettingsDisclosure";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Link } from "@/lib/router";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { describeError } from "@/api/errors";

export const githubSelectClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
const eventLabels = {
  get opened() { return translate("connections:new_pull_request_b0a4279"); },
  get synchronize() { return translate("connections:updated_commits_0dd3d0b"); },
  get reopened() { return translate("connections:reopened_063f120"); },
  get ready_for_review() { return translate("connections:ready_for_review_8c2d9db"); },
  get mention() { return translate("connections:mention_5125802"); },
  get comment() { return translate("connections:follow_up_comment_2a4c7cb"); },
};
function GitHubHelp({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation("connections");
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={t("about_f6e1083", { label: label })}
          className="inline-flex shrink-0 items-center text-muted-foreground hover:text-foreground"
          onClick={() => setOpen(true)}
        >
          <HelpCircle className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{children}</TooltipContent>
    </Tooltip>
  );
}

export function GitHubToggle({
  label,
  description,
  help,
  checked,
  onChange,
  ariaLabel,
  disabled,
}: {
  label: string;
  description?: string;
  help?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="break-words text-sm font-medium">{label}</p>
          {help && <GitHubHelp label={label}>{help}</GitHubHelp>}
        </div>
        {description && (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <ToggleSwitch
        aria-label={ariaLabel ?? label}
        disabled={disabled}
        checked={checked}
        onCheckedChange={onChange}
      />
    </div>
  );
}
/** Keep separators while typing; the saved policy still contains normalized lists. */
function GitHubListInput({
  id,
  values,
  separator = "\n",
  onChange,
}: {
  id: string;
  values: string[];
  separator?: "\n" | ",";
  onChange: (values: string[]) => void;
}) {
  const joiner = separator === "," ? ", " : "\n";
  const [text, setText] = useState(values.join(joiner));
  const parse = (value: string) =>
    value
      .split(separator)
      .map((item) => item.trim())
      .filter(Boolean);
  useEffect(() => {
    setText((current) =>
      JSON.stringify(parse(current)) === JSON.stringify(values)
        ? current
        : values.join(joiner),
    );
  }, [values, separator]);
  const props = {
    id,
    value: text,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      setText(event.target.value);
      onChange(parse(event.target.value));
    },
  };
  return separator === "\n" ? <Textarea {...props} /> : <Input {...props} />;
}

function GitHubPassingScore({
  value,
  onChange,
  onValidityChange,
  text: controlledText,
  onTextChange,
}: {
  text?: string;
  onTextChange?: (text: string) => void;
  value: GitHubReviewPolicy["ratingThreshold"];
  onChange: (value: GitHubReviewPolicy["ratingThreshold"]) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const { t } = useTranslation("connections");
  const id = useId();
  const [localText, setLocalText] = useState(String(value ?? 5));
  const text = controlledText ?? localText;
  const setText = onTextChange ?? setLocalText;
  const number = Number(text);
  const valid = value === null || (text.trim() !== "" && Number.isInteger(number) && number >= 1 && number <= 5);
  useEffect(() => setLocalText(String(value ?? 5)), [value]);
  useEffect(() => { onValidityChange?.(valid); }, [valid, onValidityChange]);
  return (
    <div className="space-y-3 py-3">
      <Label htmlFor={id}>{t("passing_score_e5cdc32")}</Label>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <Input id={id} type="number" min={1} max={5} step={1} required
            className="w-20" value={text} disabled={value === null}
            aria-invalid={!valid} aria-describedby={`${id}-help${valid ? "" : ` ${id}-error`}`}
            onChange={(event) => {
              const next = event.target.value;
              setText(next);
              const score = Number(next);
              if (next.trim() && Number.isInteger(score) && score >= 1 && score <= 5)
                onChange(score as 1 | 2 | 3 | 4 | 5);
            }} />
          <span className="text-sm text-muted-foreground">{t("out_of_5_02113fe")}</span>
        </div>
        <Label className="flex items-center gap-2 text-sm font-normal">
          <Checkbox aria-label={t("report_only_f08b1e3")} checked={value === null}
            onCheckedChange={(checked) => { setText("5"); onChange(checked === true ? null : 5); }} />{t("report_only_6b129dc")}</Label>
      </div>
      {!valid && <p id={`${id}-error`} role="alert" className="text-xs text-destructive">{t("enter_a_whole_number_from_1_to_60798e7")}</p>}
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {value === null
          ? t("publishes_a_neutral_check_without_a_score_d2a7774")
          : t("paperclip_passes_the_check_when_a_complete_472758f")}
      </p>
      <p className="text-xs text-muted-foreground">{t("to_block_merging_require_the_e81a60e")}<strong>{t("paperclip_review_aafa349")}</strong>{t("check_from_this_app_in_your_github_3b74e92")}{" "}
        <a className="underline hover:text-foreground"
          href="https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository"
          target="_blank" rel="noreferrer">{t("configure_on_github_ce5a613")}</a>
      </p>
    </div>
  );
}

export function GitHubPolicyEditor({
  policy,
  onChange,
  accessHref,
  onValidityChange,
  scoreText,
  onScoreTextChange,
  rememberedAutomaticMode,
  readOnly = false,
}: {
  accessHref?: string;
  readOnly?: boolean;
  scoreText?: string;
  onScoreTextChange?: (text: string) => void;
  rememberedAutomaticMode?: "linked_authors" | "allowed_authors";
  policy: GitHubReviewPolicy;
  onChange: (policy: GitHubReviewPolicy) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const { t } = useTranslation("connections");
  const id = useId();
  const automaticMode = useRef<"linked_authors" | "allowed_authors">(
    "linked_authors",
  );
  if (policy.invocation !== "mentions_only")
    automaticMode.current = policy.invocation;
  const filterField = (
    key:
      | "includeAuthors"
      | "excludeAuthors"
      | "targetBranches"
      | "excludedBranches"
      | "requiredLabels"
      | "excludedLabels"
      | "ignoredPaths",
    label: string,
    help: string,
  ) => (
    <div className="space-y-2">
      <Label htmlFor={`${id}-github-${key}`}>{label}</Label>
      <GitHubListInput
        id={`${id}-github-${key}`}
        values={policy[key]}
        onChange={(values) => set(key, values)}
      />
      <p className="text-xs text-muted-foreground">{help}</p>
    </div>
  );
  const [prompt, setPrompt] = useState<
    (typeof GITHUB_REVIEW_EVENTS)[number] | "issue_opened"
  >("opened");
  const set = <K extends keyof GitHubReviewPolicy>(
    key: K,
    value: GitHubReviewPolicy[K],
  ) => onChange({ ...policy, [key]: value });
  return (
    <div className="space-y-8">
      <section
        className="space-y-3"
        aria-labelledby={`${id}-github-instructions-heading`}
      >
        <h2
          id={`${id}-github-instructions-heading`}
          className="text-base font-semibold"
        >{t("instructions_b35660a")}</h2>
        <MarkdownEditor
          readOnly={readOnly}
          ariaLabel={t("agent_instructions_07101b9")}
          contentClassName="min-h-32"
          value={policy.instructions}
          placeholder={t("what_should_this_agent_do_on_github_4ec56e6")}
          onChange={(value) => set("instructions", value)}
        />
        <p className="text-xs text-muted-foreground">{t("included_in_every_github_task_type_to_1e3dc26")}</p>
        <GitHubSettingsDisclosure title={t("event_specific_instructions_be77d85")}>
          <div className="grid gap-3 pt-3">
            <Label htmlFor={`${id}-github-prompt-event`} className="sr-only">{t("event_a937286")}</Label>
            <select
              id={`${id}-github-prompt-event`}
              className={githubSelectClass}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value as typeof prompt)}
            >
              {GITHUB_REVIEW_EVENTS.map((event) => (
                <option key={event} value={event}>
                  {eventLabels[event]}
                </option>
              ))}
              <option value="issue_opened">{t("new_issue_051fba3")}</option>
            </select>
            <MarkdownEditor
              key={prompt}
              readOnly={readOnly}
              ariaLabel={finalPagesT("final-pages:event_instructions_f3704f", { event: prompt === "issue_opened" ? t("new_issue_051fba3") : eventLabels[prompt] })}
              contentClassName="min-h-32"
              value={
                prompt === "issue_opened"
                  ? (policy.issueOpenedInstructions ?? "")
                  : policy.prompts[prompt]
              }
              onChange={(value) =>
                prompt === "issue_opened"
                  ? set("issueOpenedInstructions", value)
                  : set("prompts", {
                      ...policy.prompts,
                      [prompt]: value,
                    })
              }
            />
            <p className="text-xs text-muted-foreground">{t("added_to_the_main_instructions_for_this_b004fc4")}</p>
          </div>
        </GitHubSettingsDisclosure>
      </section>
      <section
        className="space-y-3"
        aria-labelledby={`${id}-github-triggers-heading`}
      >
        <h2
          id={`${id}-github-triggers-heading`}
          className="text-base font-semibold"
        >{t("when_to_run_212b670")}</h2>
        <div className="flex items-start gap-3 py-2">
          <AtSign className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="space-y-1">
            <p className="text-sm font-medium">{t("when_mentioned_e048227")}</p>
            <p className="text-xs text-muted-foreground">{t("authorized_people_can_always_mention_this_bot_d9b481c")}{" "}
              {accessHref && (
                <Link className="underline underline-offset-4" to={accessHref}>{t("manage_people_in_access_4f4bc0c")}</Link>
              )}
            </p>
          </div>
        </div>
        <GitHubToggle
          label={t("run_automatically_c808aa1")}
          description={t("start_work_without_a_mention_when_an_b8abfc1")}
          checked={policy.invocation !== "mentions_only"}
          onChange={(enabled) =>
            set("invocation", enabled ? (rememberedAutomaticMode ?? automaticMode.current) : "mentions_only")
          }
        />
        {policy.invocation !== "mentions_only" && (
          <div className="space-y-4">
            <div
              className="grid gap-x-6 gap-y-3 sm:grid-cols-2"
              aria-label={t("automatic_events_db4e0b2")}
            >
              {GITHUB_REVIEW_EVENTS.slice(0, 4).map((event) => (
                <Label
                  key={event}
                  className="flex cursor-pointer items-center gap-3 text-sm font-normal"
                >
                  <Checkbox
                    checked={policy.events.includes(event)}
                    onCheckedChange={(enabled) =>
                      set(
                        "events",
                        enabled === true
                          ? [...new Set([...policy.events, event])]
                          : policy.events.filter((value) => value !== event),
                      )
                    }
                  />
                  {eventLabels[event]}
                </Label>
              ))}
              <Label className="flex cursor-pointer items-center gap-3 text-sm font-normal">
                <Checkbox
                  checked={policy.issueOpened === true}
                  onCheckedChange={(enabled) =>
                    set("issueOpened", enabled === true)
                  }
                />{t("new_issues_aa6a0e3")}</Label>
            </div>
            <p className="text-xs text-muted-foreground">{t("runs_for_authorized_authors_in_access_use_6233977")}</p>
            <GitHubSettingsDisclosure title={t("automatic_review_filters_a75be1a")}>
              <div>
                <GitHubToggle
                  label={t("include_draft_prs_1d89aee")}
                  checked={policy.reviewDrafts}
                  onChange={(value) => set("reviewDrafts", value)}
                />
                <GitHubToggle
                  label={t("include_bot_authors_50e84f5")}
                  description={t("the_account_also_needs_a_sponsor_and_8764a8d")}
                  checked={policy.reviewBotAuthors}
                  onChange={(value) => set("reviewBotAuthors", value)}
                />
              </div>
              <GitHubSettingsDisclosure title={t("authors_d2a5254")}>
                <div className="grid gap-4 sm:grid-cols-2">
                  {filterField(
                    "includeAuthors",
                    t("included_authors_5031600"),
                    t("leave_empty_for_all_authorized_authors_one_71d7705"),
                  )}
                  {filterField(
                    "excludeAuthors",
                    t("excluded_authors_5a510d9"),
                    t("one_username_or_glob_per_line_de26b9d"),
                  )}
                </div>
              </GitHubSettingsDisclosure>
              <GitHubSettingsDisclosure title={t("branches_f578227")}>
                <div className="grid gap-4 sm:grid-cols-2">
                  {filterField(
                    "targetBranches",
                    t("target_branches_39a5bd5"),
                    t("leave_empty_for_all_branches_supports_and_bc4684a"),
                  )}
                  {filterField(
                    "excludedBranches",
                    t("excluded_branches_c6ba5ce"),
                    t("supports_and_5e48476"),
                  )}
                </div>
              </GitHubSettingsDisclosure>
              <GitHubSettingsDisclosure title={t("labels_2228985")}>
                <div className="grid gap-4 sm:grid-cols-2">
                  {filterField(
                    "requiredLabels",
                    t("required_labels_3ef7393"),
                    t("all_listed_labels_must_be_present_55a7fca"),
                  )}
                  {filterField(
                    "excludedLabels",
                    t("excluded_labels_2de1469"),
                    t("any_listed_label_prevents_automatic_review_c447830"),
                  )}
                </div>
              </GitHubSettingsDisclosure>
              <p className="text-xs text-muted-foreground">{t("reviews_requested_by_mention_bypass_these_scheduling_0e7d352")}</p>
            </GitHubSettingsDisclosure>
          </div>
        )}
      </section>
      <section
        className="space-y-3"
        aria-labelledby={`${id}-github-results-heading`}
      >
        <h2
          id={`${id}-github-results-heading`}
          className="text-base font-semibold"
        >{t("review_results_89ad3ef")}</h2>
        <div className="grid gap-x-8 sm:grid-cols-2">
          <GitHubToggle
            label={t("post_a_review_summary_79aa28f")}
            checked={policy.publishSummary}
            onChange={(value) => set("publishSummary", value)}
          />
          <GitHubToggle
            label={t("post_inline_findings_8e99c0b")}
            checked={policy.publishInline}
            onChange={(value) => set("publishInline", value)}
          />
        </div>
        <GitHubPassingScore value={policy.ratingThreshold} text={scoreText} onTextChange={onScoreTextChange}
          onChange={(value) => set("ratingThreshold", value)} onValidityChange={onValidityChange} />
      </section>
      <div className="divide-y divide-border">
        <GitHubSettingsDisclosure title={t("ignored_files_14c879b")}>
          {filterField(
            "ignoredPaths",
            t("file_patterns_939e8ac"),
            t("excluded_from_all_reviews_including_mentions_one_d0c28ef"),
          )}
        </GitHubSettingsDisclosure>
        <GitHubSettingsDisclosure title={t("inline_comment_options_beab8cc")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`${id}-github-categories`}>{t("finding_categories_01a467f")}</Label>
              <GitHubListInput
                id={`${id}-github-categories`}
                values={policy.findingCategories}
                separator=","
                onChange={(values) => set("findingCategories", values)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${id}-github-severity`}>{t("minimum_inline_severity_283b132")}</Label>
              <select
                id={`${id}-github-severity`}
                className={githubSelectClass}
                value={policy.minimumCommentSeverity}
                onChange={(e) =>
                  set(
                    "minimumCommentSeverity",
                    e.target
                      .value as GitHubReviewPolicy["minimumCommentSeverity"],
                  )
                }
              >
                <option value="info">{t("info_4b631f6")}</option>
                <option value="warning">{t("warning_e9c4556")}</option>
                <option value="error">{t("error_7f2f6a1")}</option>
              </select>
              <p className="text-xs text-muted-foreground">{t("hidden_findings_still_count_in_the_assessment_1512a26")}</p>
            </div>
          </div>
        </GitHubSettingsDisclosure>
        <GitHubSettingsDisclosure title={t("approvals_and_change_requests_a61b331")}>
          <p className="text-xs text-muted-foreground">{t("optional_formal_decisions_on_github_scores_comments_b9ed27c")}</p>
          <div>
            <GitHubToggle
              label={t("allow_approvals_75f8a1b")}
              help={t("lets_the_agent_submit_an_approve_review_78a5850")}
              checked={policy.allowApprove}
              onChange={(value) => set("allowApprove", value)}
            />
            <GitHubToggle
              label={t("allow_request_changes_4fe5f20")}
              help={t("lets_the_agent_submit_a_request_changes_fb088e5")}
              checked={policy.allowRequestChanges}
              onChange={(value) => set("allowRequestChanges", value)}
            />
          </div>
        </GitHubSettingsDisclosure>
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
  const { t } = useTranslation("connections");
  const company = useOptionalCompany()?.companies.find((item) => item.id === companyId);
  const accountLink = useRef<HTMLAnchorElement>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [dialog, setDialog] = useState<"member" | "guest" | null>(null);
  const members = useQuery({
    queryKey: ["github-members", companyId],
    queryFn: () => accessApi.listMembers(companyId),
  });
  const links = useQuery({
    queryKey: ["github-linked-members", endpointId],
    queryFn: () => chatEndpointsApi.listPrincipals(endpointId),
  });
  const membersView = useQueryView(members);
  const linksView = useQueryView(links);
  const linksLoaded = linksView.kind === "ready" || linksView.kind === "stale";
  const [login, setLogin] = useState("");
  const [sponsor, setSponsor] = useState(configuration.responsibleUserId);
  const [candidate, setCandidate] = useState<{
    githubUserId: string;
    login: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [lookupError, setLookupError] = useState("");
  const [busy, setBusy] = useState(false);
  const activeMembers = (members.data?.members ?? []).filter(
    (member) =>
      member.status === "active" && member.membershipRole !== "viewer",
  );
  const linkedAccounts = (links.data ?? []).filter(
    (link) => link.status === "linked",
  );
  const responsible = activeMembers.find(
    (member) => member.principalId === configuration.responsibleUserId,
  );
  const memberName = (userId: string) =>
    activeMembers.find((member) => member.principalId === userId)?.user?.name ??
    userId;
  const automatic = configuration.defaults.invocation !== "mentions_only";
  const guestsAutomatic =
    configuration.defaults.invocation === "allowed_authors";
  const guests = configuration.people.filter(
    (person) => person.kind === "guest",
  );
  // Preserve configured members whose identity link was revoked; show why they cannot run.
  const memberRows = [
    ...configuration.people.filter((person) => person.kind === "member"),
    ...linkedAccounts
      .filter(
        (link) =>
          link.githubUserId &&
          link.paperclipUserId &&
          !configuration.people.some(
            (person) => person.githubUserId === link.githubUserId,
          ),
      )
      .map((link): GitHubAllowedPerson => ({
        kind: "member",
        userId: link.paperclipUserId!,
        githubUserId: link.githubUserId!,
        login: link.githubLogin ?? link.externalLabel,
      })),
  ];
  const updatePerson = (person: GitHubAllowedPerson) =>
    onChange({
      ...configuration,
      people: configuration.people.some(
        (p) => p.githubUserId === person.githubUserId,
      )
        ? configuration.people.map((p) =>
            p.githubUserId === person.githubUserId ? person : p,
          )
        : [...configuration.people, person],
    });
  const removePerson = (person: GitHubAllowedPerson) =>
    onChange({
      ...configuration,
      people: configuration.people.filter(
        (p) => p.githubUserId !== person.githubUserId,
      ),
    });
  const unlink = async (principalId: string) => {
    setBusy(true);
    setError("");
    try {
      await chatEndpointsApi.revokeLink(endpointId, principalId);
      await links.refetch();
    } catch (e) {
      setError(
        describeError(e).body,
      );
    } finally {
      setBusy(false);
    }
  };
  const peopleRows = (people: GitHubAllowedPerson[]) => (
    <div className="divide-y divide-border">
      {people.map((person) => {
        const identity = linkedAccounts.find(
          (link) => link.githubUserId === person.githubUserId,
        );
        const linked = person.kind === "guest" || Boolean(identity);
        const explicit = configuration.people.some(
          (p) => p.githubUserId === person.githubUserId,
        );
        const mentions =
          person.kind === "guest" ||
          configuration.memberAccess === "all_linked" ||
          explicit;
        const removable = explicit && (person.kind === "guest" || configuration.memberAccess === "selected");
        return (
          <div
            key={person.githubUserId}
            className="flex flex-wrap items-center gap-x-4 gap-y-3 py-4"
          >
            <div className="min-w-0 flex-1 basis-32">
              <p className="break-words text-sm font-medium">@{person.login}</p>
              <p className="text-xs text-muted-foreground">
                {person.kind === "guest"
                  ? t("sponsored_by_452d1a3", { value: memberName(person.sponsorUserId) })
                  : (identity?.paperclipUserLabel ?? t("company_member_069970c"))}
              </p>
              {!linked && (
                <p className="mt-1 text-xs text-destructive">{t("github_account_needs_linking_56ae323")}</p>
              )}
            </div>
            <div className="flex items-center gap-5">
              <div className="flex flex-col items-center gap-2">
                <span className="text-xs text-muted-foreground">{t("mentions_85e12bc")}</span>
                {person.kind === "guest" ||
                configuration.memberAccess === "all_linked" ? (
                  <span
                    className="flex h-5 items-center gap-1 text-xs"
                    aria-label={t("mentions_for_dd2f3ab", { status: linked ? t("reviewBAllowed") : t("reviewBUnavailable"), login: person.login })}
                  >
                    {linked && (
                      <Check className="size-3.5 text-muted-foreground" />
                    )}
                    {linked ? t("allowed_77c7b49") : t("unlinked_86998ac")}
                  </span>
                ) : (
                  <ToggleSwitch
                    aria-label={t("allow_mentions_from_13d8a1b", { login: person.login })}
                    checked={mentions}
                    disabled={!linked}
                    onCheckedChange={(enabled) =>
                      enabled ? updatePerson(person) : removePerson(person)
                    }
                  />
                )}
              </div>
              {(identity || removable) && <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("manage_187f166", { login: person.login })}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {removable && (
                    <DropdownMenuItem onClick={() => removePerson(person)}>{t("remove_access_a38b97c")}</DropdownMenuItem>
                  )}
                  {identity && (
                    <DropdownMenuItem
                      disabled={busy}
                      onClick={() => void unlink(identity.principalId)}
                    >{t("unlink_github_account_813727c")}</DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>}
            </div>
          </div>
        );
      })}
    </div>
  );
  return (
    <section className="space-y-6" aria-label={t("people_b37554f")}>
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("people_b37554f")}</h2>
        <p className="text-sm text-muted-foreground">{t("choose_who_can_mention_this_bot_and_ef88687")}</p>
      </div>
      <section className="space-y-2" aria-label={t("company_members_f47cd5a")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t("company_members_f47cd5a")}</h3>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDialog("member");
              setLinkCopied(false);
              setError("");
            }}
          >
            <Plus className="size-4" />{t("link_a_member_283a75f")}</Button>
        </div>
        <GitHubToggle
          label={t("allow_mentions_from_all_linked_members_954e7f8")}
          description={
            configuration.memberAccess === "all_linked"
              ? t("includes_members_from_who_link_their_github_cf1cb05", { value: company?.name ?? t("this_company_a319f8d") })
              : t("only_members_you_enable_below_can_mention_bdc34bd")
          }
          checked={configuration.memberAccess === "all_linked"}
          onChange={(enabled) =>
            onChange({
              ...configuration,
              memberAccess: enabled ? "all_linked" : "selected",
            })
          }
        />
        {peopleRows(memberRows)}
        {(links.isPending || linksView.kind === "reconnecting") && (
          <p role="status" className="py-4 text-sm text-muted-foreground">{t("loading_linked_accounts_33a8af2")}</p>
        )}
        {linksLoaded && memberRows.length === 0 && (
          <p className="py-4 text-sm text-muted-foreground">{t("no_members_linked_yet_link_an_account_ee06c52")}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {automatic ? (
            <>{t("automatic_runs_use_the_events_and_author_de1b43a")}{" "}
              <Link
                className="underline underline-offset-4"
                to={`/apps/chat/${endpointId}/settings`}
              >{t("settings_4628f19")}</Link>
              .
            </>
          ) : (
            <>{t("automatic_runs_are_off_in_8ca91f4")}{" "}
              <Link
                className="underline underline-offset-4"
                to={`/apps/chat/${endpointId}/settings`}
              >{t("settings_4628f19")}</Link>{t("authorized_mentions_still_work_3a59766")}</>
          )}
        </p>
      </section>
      <section
        className="space-y-2 border-t border-border pt-6"
        aria-label={t("external_contributors_6fe128a")}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t("external_contributors_6fe128a")}</h3>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDialog("guest");
              setLookupError("");
            }}
          >
            <Plus className="size-4" />{t("add_external_contributor_98eac3c")}</Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("allow_specific_github_users_with_a_member_8a10d02")}</p>
        {peopleRows(guests)}
        {guests.length > 0 && (
          <GitHubToggle
            label={t("allow_automatic_runs_for_external_contributors_082a707")}
            description={
              automatic
                ? t("authorized_contributors_can_trigger_the_events_and_d03a08c")
                : t("turn_on_automatic_runs_in_settings_first_23ce80c")
            }
            checked={guestsAutomatic}
            disabled={!automatic}
            onChange={(enabled) =>
              onChange({
                ...configuration,
                defaults: {
                  ...configuration.defaults,
                  invocation: enabled ? "allowed_authors" : "linked_authors",
                },
              })
            }
          />
        )}
      </section>
      <GitHubSettingsDisclosure title={t("automatic_task_responsibility_743c44e")}>
        <div className="space-y-2">
          {activeMembers.length === 1 && responsible ? (
            <p className="text-sm">{t("responsible_member_3c7c59b", { value: memberName(configuration.responsibleUserId) })}</p>
          ) : (
            <>
              <Label htmlFor="github-responsible">{t("responsible_member_1c73f22")}</Label>
              <select
                id="github-responsible"
                className={githubSelectClass}
                value={configuration.responsibleUserId}
                onChange={(e) =>
                  onChange({
                    ...configuration,
                    responsibleUserId: e.target.value,
                  })
                }
              >
                {!responsible && (
                  <option value={configuration.responsibleUserId}>
                    {configuration.responsibleUserId || t("select_a_member_6d59367")}
                  </option>
                )}
                {activeMembers.map((member) => (
                  <option key={member.principalId} value={member.principalId}>
                    {member.user?.name ??
                      member.user?.email ??
                      member.principalId}
                  </option>
                ))}
              </select>
            </>
          )}
          <p className="text-xs text-muted-foreground">{t("the_member_accountable_for_automatically_created_paperclip_607ff35")}</p>
        </div>
      </GitHubSettingsDisclosure>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {(membersView.kind === "error" || linksView.kind === "error") && (
        <QueryErrorState
          error={membersView.kind === "error" ? members.error : links.error}
          action="load members and linked accounts"
          onRetry={() => {
            membersView.retry();
            linksView.retry();
          }}
          retrying={members.isFetching || links.isFetching}
        />
      )}
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog === "member"
                ? t("link_a_company_member_2427afb")
                : t("add_external_contributor_b3a010d")}
            </DialogTitle>
            <DialogDescription>
              {dialog === "member"
                ? t("each_member_confirms_their_own_github_identity_fc9945e")
                : t("allow_a_github_user_to_mention_this_5b41025")}
            </DialogDescription>
          </DialogHeader>
          {dialog === "member" ? (
            <>
              <Button
                variant="outline"
                aria-label={t("copy_account_linking_url_6f748a9")}
                onClick={() => {
                  if (accountLink.current)
                    void copyTextToClipboard(accountLink.current.href).then(
                      () => setLinkCopied(true),
                      () =>
                        setError(
                          finalPagesT("final-pages:Could_not_copy_the_link_Open_account_linking_and_copy_the_address_e3f2cb"),
                        ),
                    );
                }}
              >
                <Copy className="size-4" />
                {linkCopied ? t("copied_8e3df45") : t("copy_invitation_link_ef359b7")}
              </Button>
              <Link
                ref={accountLink}
                to={`/apps/chat/connect?provider=github&resume=${endpointId}&stage=identity`}
                className="text-sm underline underline-offset-4"
              >{t("link_your_account_7c1ff55")}</Link>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="github-guest-login">{t("github_username_7658eba")}</Label>
                <div className="flex gap-2">
                  <Input
                    id="github-guest-login"
                    value={login}
                    placeholder="octocat"
                    disabled={busy}
                    onChange={(e) => {
                      setLogin(e.target.value);
                      setCandidate(null);
                      setLookupError("");
                    }}
                  />
                  <Button
                    variant="outline"
                    disabled={busy || !login.trim()}
                    onClick={async () => {
                      setBusy(true);
                      setLookupError("");
                      setCandidate(null);
                      try {
                        setCandidate(
                          await githubChatApi.lookup(endpointId, login),
                        );
                      } catch (e) {
                        setLookupError(
                          describeError(e).body,
                        );
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {busy ? t("looking_up_27d9ea3") : t("look_up_6d7049b")}
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="github-guest-sponsor">{t("sponsor_fd0b743")}</Label>
                <select
                  id="github-guest-sponsor"
                  className={githubSelectClass}
                  value={sponsor}
                  onChange={(e) => setSponsor(e.target.value)}
                >
                  {!activeMembers.some(
                    (member) => member.principalId === sponsor,
                  ) && <option value={sponsor}>{t("select_a_member_6d59367")}</option>}
                  {activeMembers.map((member) => (
                    <option key={member.principalId} value={member.principalId}>
                      {member.user?.name ?? member.principalId}
                    </option>
                  ))}
                </select>
              </div>
              {candidate && (
                <p role="status" className="text-sm">
                  {configuration.people.some(
                    (p) => p.githubUserId === candidate.githubUserId,
                  ) ||
                  linkedAccounts.some(
                    (link) => link.githubUserId === candidate.githubUserId,
                  )
                    ? t("is_already_listed_in_people_9f53f5f", { login: candidate.login })
                    : t("found_they_will_be_able_to_mention_ad206dd", { login: candidate.login })}
                </p>
              )}
              {lookupError && (
                <p role="alert" className="text-sm text-destructive">
                  {lookupError}
                </p>
              )}
              <DialogFooter className="flex-row justify-between sm:justify-between">
                <Button variant="ghost" onClick={() => setDialog(null)}>{t("cancel_1791a62")}</Button>
                <Button
                  disabled={
                    !candidate ||
                    !activeMembers.some(
                      (member) => member.principalId === sponsor,
                    ) ||
                    configuration.people.some(
                      (p) => p.githubUserId === candidate.githubUserId,
                    ) ||
                    linkedAccounts.some(
                      (link) => link.githubUserId === candidate.githubUserId,
                    )
                  }
                  onClick={() => {
                    if (candidate) {
                      updatePerson({
                        ...candidate,
                        kind: "guest",
                        sponsorUserId: sponsor,
                        permissionProfile: "restricted",
                      });
                      setDialog(null);
                      setCandidate(null);
                      setLogin("");
                    }
                  }}
                >{t("add_contributor_c58f5ed")}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
