// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { i18n } from "@/i18n";
import { ApiError } from "@/api/client";
import { ThemeProvider } from "@/context/ThemeContext";
import { TooltipProvider } from "./ui/tooltip";
import { InteractionAudienceLine } from "./InteractionAudienceLine";
import { IssueThreadInteractionCard } from "./IssueThreadInteractionCard";
import { TaskChatCompactInteractionCard } from "./task-chat/TaskChatCompactInteractionCard";
import {
  pendingAskUserQuestionsInteraction,
  humanOnlyRequestConfirmationInteraction,
} from "@/fixtures/issueThreadInteractionFixtures";
import {
  RESOLVER_POLICY_CHOICES,
  describeResolverAudience,
  describeResolverAudienceDisplay,
  describeAttentionResolverAudienceDisplay,
  getResolverPolicyChoicesDisplay,
  resolverPolicyLabelDisplay,
  type InteractionAudienceFacts,
} from "@/lib/interaction-audience";
import {
  describeInteractionResolutionFailure,
  describeInteractionResolutionFailureDisplay,
  InteractionResolutionDisplayError,
} from "@/lib/interaction-resolution-error";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const facts: InteractionAudienceFacts = {
  effectiveResolverPolicy: "anyone",
  requestedResolverPolicy: "anyone",
  effectiveResolverPolicySource: "requested",
  resolverPolicyProvenance: "inherited",
  hasAddressee: false,
};

describe("interaction audience display localization", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    await i18n.changeLanguage("ru");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    await i18n.changeLanguage("en");
  });
  async function locale(value: string) {
    await act(async () => { await i18n.changeLanguage(value); });
  }
  async function render(node: ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => root.render(
      <QueryClientProvider client={client}><TooltipProvider><ThemeProvider>{node}</ThemeProvider></TooltipProvider></QueryClientProvider>,
    ));
  }

  it("updates a captured audience and compact title without remounting or altering policy facts", async () => {
    const snapshot = { ...facts, effectiveResolverPolicy: "human_only" as const, effectiveResolverPolicySource: "company_cap" as const };
    const original = describeResolverAudience({ facts: snapshot });
    const audience = describeResolverAudienceDisplay({ facts: snapshot });
    const choices = getResolverPolicyChoicesDisplay();
    await render(<InteractionAudienceLine audience={audience} variant="compact" />);
    const element = host.querySelector('[data-testid="interaction-audience"]')!;
    for (const language of ["ru", "en", "ru"]) {
      await locale(language);
      expect(host.querySelector('[data-testid="interaction-audience"]')).toBe(element);
      expect(element.textContent).toContain(language === "ru" ? "Ответить может только совет" : "Only the board can respond");
      expect(element.getAttribute("title")).toContain(language === "ru" ? "с «Любой участник» до «Только человек»" : "from Anyone to Human only");
      expect(element.getAttribute("data-audience-policy")).toBe("human_only");
      expect(element.getAttribute("data-audience-open")).toBe("false");
      expect(audience.narrowedBy).toBe(original.narrowedBy);
      expect(audience.isOpen).toBe(original.isOpen);
      expect(describeResolverAudience({ facts: snapshot })).toEqual(original);
      expect(choices[0].label).toBe(language === "ru" ? "Любой участник" : "Anyone");
      expect(choices.map(({ value, isDefault }) => ({ value, isDefault }))).toEqual(
        RESOLVER_POLICY_CHOICES.map(({ value, isDefault }) => ({ value, isDefault })),
      );
      expect(resolverPolicyLabelDisplay("board_only")).toBe(language === "ru" ? "Только человек" : "Human only");
    }
  });

  it("selects full phrases from facts, never from translated actor names", async () => {
    const self = describeResolverAudienceDisplay({
      facts: { ...facts, hasAddressee: true, isUserAddressee: true },
      addresseeLabel: "Вы",
      isAddresseeCurrentUser: true,
    });
    const namedYou = describeResolverAudienceDisplay({
      facts: { ...facts, hasAddressee: true },
      addresseeLabel: "You",
    });
    const namedCyrillic = describeResolverAudienceDisplay({
      facts: { ...facts, effectiveResolverPolicy: "not_creator" },
      creatorLabel: "Иван",
    });
    for (const language of ["ru", "en", "ru"]) {
      await locale(language);
      expect(self.summary).toBe(language === "ru" ? "Ответить можете только вы." : "Only you can respond.");
      expect(namedYou.summary).toBe(language === "ru"
        ? "Ответить может только агент-адресат (You) или человек из совета."
        : "Only You or a person on the board can respond.");
      expect(namedCyrillic.summary).toContain(language === "ru" ? "Автор карточки (Иван)" : "except Иван");
    }
  });

  it("keeps every precedence and narrowing invariant across the display matrix", async () => {
    for (const language of ["ru", "en", "ru"]) {
      await locale(language);
      for (const policy of ["anyone", "not_creator", "human_only"] as const) {
        for (const source of ["requested", "company_cap", "governed_action"] as const) {
          for (const addressee of ["none", "agent", "user"] as const) {
            const snapshot = { ...facts, effectiveResolverPolicy: policy, effectiveResolverPolicySource: source,
              hasAddressee: addressee !== "none", isUserAddressee: addressee === "user" };
            const raw = describeResolverAudience({ facts: snapshot });
            const display = describeResolverAudienceDisplay({ facts: snapshot });
            for (const key of ["policy", "requestedPolicy", "isOpen", "narrowedBy"] as const) {
              expect(display[key]).toBe(raw[key]);
            }
            expect(display.summary).not.toContain("localizationInteractionAudience");
            if (language === "en") expect(display).toEqual(raw);
            if (addressee === "user") expect(display.shortSummary).toBe(language === "ru"
              ? "Ответить может только пользователь-адресат" : "Only the addressed user can respond");
          }
        }
      }
      const legacy = describeResolverAudienceDisplay({ facts: { ...facts,
        effectiveResolverPolicy: "not_creator", resolverPolicyProvenance: "legacy_inherited_restriction" } });
      expect(legacy.narrowedNote).toContain(language === "ru" ? "ограничение сохраняется" : "stays restricted");
      expect(describeAttentionResolverAudienceDisplay({ sourceKind: "issue_thread_interaction" })).toBeNull();
      expect(describeAttentionResolverAudienceDisplay({ sourceKind: "approval" })).toBeNull();
    }
  });

  it("localizes the current-user audience in the full rendered card without parsing Вы or You", async () => {
    const interaction = { ...humanOnlyRequestConfirmationInteraction, addresseeUserId: "user-current" };
    await render(<IssueThreadInteractionCard interaction={interaction} currentUserId="user-current" />);
    const summary = host.querySelector('[data-testid="interaction-audience-summary"]')!;
    for (const language of ["ru", "en", "ru"]) {
      await locale(language);
      expect(host.querySelector('[data-testid="interaction-audience-summary"]')).toBe(summary);
      expect(summary.textContent).toBe(language === "ru" ? "Ответить можете только вы." : "Only you can respond.");
      expect(interaction.addresseeUserId).toBe("user-current");
    }
  });

  it("retains denial, settled and transient classification for every canonical error code", async () => {
    const codes = ["interaction_human_only", "interaction_creator_excluded", "interaction_addressee_mismatch",
      "interaction_governed_action_denied", "interaction_run_attribution_required", "interaction_scope_denied",
      "interaction_not_found", "interaction_already_resolved", "interaction_superseded", "interaction_stale_target",
      "interaction_issue_closed", "unknown-code"];
    for (const language of ["ru", "en", "ru"]) {
      await locale(language);
      for (const code of codes) {
        const cause = { status: 403, body: { details: { code } } };
        const raw = describeInteractionResolutionFailure(cause);
        const display = describeInteractionResolutionFailureDisplay(cause);
        expect(display.kind).toBe(raw.kind);
        expect(display.code).toBe(code);
        if (raw.kind !== "transient") expect(display.message).not.toMatch(/Try again|Попробуйте/);
        expect(display.message).not.toContain("localizationInteractionAudience");
        if (language === "en") expect(display.message).toBe(raw.message);
      }
      expect(describeInteractionResolutionFailureDisplay({ status: 403 }).message).toBe(language === "ru"
        ? "У вас нет права отвечать на эту карточку." : "You do not have permission to respond to this card.");
    }
  });

  it("keeps raw refusal classification and unknown details while a captured error changes language", async () => {
    const audience = describeResolverAudienceDisplay({ facts: { ...facts, effectiveResolverPolicy: "human_only" } });
    const cause = new ApiError("This issue-thread interaction is human-only", 403, {
      error: "This issue-thread interaction is human-only", code: "interaction_human_only",
    });
    const envelope = new InteractionResolutionDisplayError(cause, audience);
    const original = describeInteractionResolutionFailure(cause);
    const custom = new ApiError("Custom raw reason: ALLOW_RAW_17", 403, { code: "interaction_scope_denied", error: "Custom raw reason: ALLOW_RAW_17" });
    for (const language of ["ru", "en", "ru"]) {
      await locale(language);
      expect(envelope.resolutionCause).toBe(cause);
      expect(envelope.message).toBe(original.message);
      expect(envelope.displayMessage).toBe(language === "ru"
        ? "На эту карточку в обсуждении задачи может ответить только человек. Ответить может только совет."
        : "This issue-thread interaction is human-only. Only the board can respond.");
      const display = describeInteractionResolutionFailureDisplay(cause, audience);
      expect(display.kind).toBe(original.kind);
      expect(display.code).toBe(original.code);
      expect(display.message).not.toMatch(/Try again|Попробуйте/);
      expect(describeInteractionResolutionFailureDisplay(custom, audience).message).toContain("Custom raw reason: ALLOW_RAW_17.");
      const unknownCode = new ApiError("Unknown raw reason", 403, { code: "new_server_code", error: "Unknown raw reason" });
      expect(describeInteractionResolutionFailureDisplay(unknownCode).kind).toBe("transient");
      expect(describeInteractionResolutionFailureDisplay(unknownCode).message).toBe(language === "ru"
        ? "Unknown raw reason. Попробуйте ещё раз." : "Unknown raw reason. Try again.");
      expect(describeInteractionResolutionFailure(cause)).toEqual(original);
    }
  });

  it("keeps a full card's refused action and stored error live without changing the callback payload", async () => {
    const interaction = humanOnlyRequestConfirmationInteraction;
    const submit = vi.fn(async (_interaction: unknown, ..._payload: unknown[]) => { throw new ApiError("This issue-thread interaction is human-only", 403, {
      code: "interaction_human_only", error: "This issue-thread interaction is human-only",
    }); });
    await render(<IssueThreadInteractionCard interaction={interaction} onAcceptInteraction={submit} />);
    const accept = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Approve"))!;
    expect(accept).toBeTruthy();
    await act(async () => accept.click());
    expect(submit.mock.calls[0][0]).toBe(interaction);
    const error = host.querySelector('[data-testid="interaction-action-error"]')!;
    for (const language of ["ru", "en", "ru"]) {
      await locale(language);
      expect(host.querySelector('[data-testid="interaction-action-error"]')).toBe(error);
      expect(error.textContent).toContain(language === "ru" ? "Ответить может только совет." : "Only the board can respond.");
      expect(host.contains(accept)).toBe(true);
      expect(accept.disabled).toBe(false);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(interaction.status).toBe("pending");
    }
  });

  it("keeps selected raw options and a compact question refusal through ru → en → ru", async () => {
    const interaction = { ...pendingAskUserQuestionsInteraction,
      effectiveResolverPolicy: "human_only" as const, requestedResolverPolicy: "human_only" as const,
      payload: { version: 1 as const, questions: [{ id: "question-raw", prompt: "Original English question?",
        selectionMode: "multi" as const, options: [{ id: "answer-raw", label: "Original option" }] }] },
    };
    const submit = vi.fn(async (_interaction: unknown, ..._payload: unknown[]) => { throw new ApiError("This issue-thread interaction is human-only", 403, {
      code: "interaction_human_only", error: "This issue-thread interaction is human-only",
    }); });
    await render(<TaskChatCompactInteractionCard interaction={interaction} onSubmitInteractionAnswers={submit} />);
    const option = host.querySelector<HTMLButtonElement>('button[role="checkbox"]')!;
    await act(async () => option.click());
    const send = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Отправить"))!;
    expect(send).toBeTruthy();
    await act(async () => send.click());
    expect(submit.mock.calls[0]).toEqual([interaction, [{ questionId: "question-raw", optionIds: ["answer-raw"] }]]);
    for (const language of ["ru", "en", "ru"]) {
      await locale(language);
      expect(host.querySelector('button[role="checkbox"]')).toBe(option);
      expect(option.getAttribute("aria-checked")).toBe("true");
      expect(host.textContent).toContain("Original English question?");
      expect(host.textContent).toContain("Original option");
      expect(host.textContent).toContain(language === "ru"
        ? "На эту карточку в обсуждении задачи может ответить только человек."
        : "This issue-thread interaction is human-only.");
      expect(submit).toHaveBeenCalledTimes(1);
    }
  });
});
