import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogOriginalPhaseDeadline } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { createIssueThreadInteractionSchema } from "../../../packages/shared/src/validators/issue.js";
import { pollUntil } from "../api.js";
import { checks, project, entity, hasLink, putDocument, type Entity } from "./internal-support.js";
import { identityDefinition, identityObservation, observeIdentity, openStandingChat, readAgentResource, waitForReply, remainingIdentityObservationBudget, type Interaction } from "./identity-support.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { createAuthenticatedPerson, enrollPrerequisitePerson } from "./identity-auth.js";
/** The setup-chosen person the wrong-reviewer card is addressed to. */
export const WRONG_REVIEWER_ADDRESSEE = "Riley";
const audiencePeople = new WeakMap<ChatCatalogContext, Awaited<ReturnType<typeof createAuthenticatedPerson>>>();

async function cards(ctx: ChatCatalogContext) {
  await ctx.refreshIssue(); return ctx.issue() ? ctx.input.api.get<Interaction[]>(`/api/issues/${ctx.issue()!.id}/interactions`) : [];
}
/** Factual current form metadata, as an ordinary editable task description; no answers or tool instructions. */
export function multipartExistingFormDescription(original: Interaction) {
  if (original.kind !== "ask_user_questions" || original.status !== "pending" || !original.id || !original.title) throw new Error("Existing multipart context requires its current pending form");
  const parsed = createIssueThreadInteractionSchema.parse({ kind: original.kind, title: original.title, payload: original.payload });
  if (parsed.kind !== "ask_user_questions") throw new Error("Existing form must remain a question");
  return `# Existing launch-page form\n\n${JSON.stringify({ id: original.id, title: original.title, status: original.status, questionSet: parsed.payload.questionSet }, null, 2)}`;
}
async function questionFixture(ctx: ChatCatalogContext, multipart: boolean) {
  const source = await openStandingChat(ctx);
  const payload = createIssueThreadInteractionSchema.parse({ kind: "ask_user_questions", title: "Launch page details", continuationPolicy: "wake_assignee",
    payload: { version: 1, supersedeOnUserComment: false, questionSet: { schema: "paperclip.question_set.v1", title: "Launch page details", submitLabel: "Submit answers",
      questions: multipart ? [
        { id: "audience", prompt: "Who is the audience?", answerMode: "single_select", required: true, options: [{ id: "researchers", label: "Researchers" }, { id: "teams", label: "Teams" }] },
        { id: "tone", prompt: "What tone should we use?", answerMode: "single_select", required: true, options: [{ id: "clear", label: "Clear" }, { id: "playful", label: "Playful" }] },
        { id: "headline", prompt: "What is your custom headline?", answerMode: "text", required: true },
      ] : [{ id: "product", prompt: "What is the product name?", answerMode: "text", required: true }],
    } } });
  const original = await ctx.input.api.post<Interaction>(`/api/issues/${source.id}/interactions`, payload);
  if (multipart) {
    const description = multipartExistingFormDescription(original);
    const saved = await ctx.input.api.patch<{ id: string; description: string }>(`/api/issues/${source.id}`, { description });
    if (saved.id !== source.id || saved.description !== description) throw new Error("Existing multipart form context was not saved on its source");
  }
  await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
  return { original, answer: `Acorn ${ctx.input.nonce}`, sourceId: source.id };
}
async function answerText(ctx: ChatCatalogContext, answer: string) {
  const form = ctx.input.page.getByTestId("task-chat-composer-takeover");
  await expect(form).toBeVisible();
  const text = form.getByTestId("question-text-answer-composer");
  if (await text.isVisible()) await text.locator('[contenteditable="true"],textarea').first().fill(answer);
  else {
    const pending = (await cards(ctx)).find(row => row.kind === "ask_user_questions" && row.status === "pending");
    const label = pending?.payload.questionSet?.questions[0]?.customAnswer?.label ?? "Other";
    await form.getByRole("radio", { name: label, exact: true }).click();
    await form.getByTestId("question-other-answer-composer").locator('[contenteditable="true"],textarea').first().fill(answer);
  }
  await form.getByRole("button", { name: /^(Submit|Send) answers$/ }).click();
}
/** The one required question of the agent's card, when every other question on it is optional. */
export function soleRequiredQuestion(card: Pick<Interaction, "payload"> | undefined) {
  const questions = card?.payload.questionSet?.questions ?? [];
  const required = questions.filter(question => question.required === true);
  return required.length === 1 ? required[0] : undefined;
}
/** Answer the card as a person would: page through it, answer its one required question and Skip
 * each optional one. A card with several questions shows Next until its last page. */
async function answerRequiredQuestion(ctx: ChatCatalogContext, answer: string) {
  const form = ctx.input.page.getByTestId("task-chat-composer-takeover");
  await expect(form).toBeVisible();
  const card = (await cards(ctx)).find(row => row.kind === "ask_user_questions" && row.status === "pending");
  const questions = card?.payload.questionSet?.questions ?? [];
  if (questions.length <= 1) return answerText(ctx, answer);
  const required = soleRequiredQuestion(card);
  if (!required) throw new Error("The agent's question card does not have exactly one required question");
  for (const [index, question] of questions.entries()) {
    const last = index === questions.length - 1;
    // Pages follow the card's question order; only an optional question's page offers Skip.
    const skip = form.getByRole("button", { name: "Skip", exact: true });
    if (question.id !== required.id) {
      // Skip leaves an optional question unanswered and moves on (or sends, on the last page).
      await skip.click();
      continue;
    }
    await expect(skip).toBeHidden();
    const text = form.getByTestId("question-text-answer-composer");
    if (await text.isVisible()) await text.locator('[contenteditable="true"],textarea').first().fill(answer);
    else {
      await form.getByRole("radio", { name: question.customAnswer?.label ?? "Other", exact: true }).click();
      await form.getByTestId("question-other-answer-composer").locator('[contenteditable="true"],textarea').first().fill(answer);
    }
    await form.getByRole("button", last ? { name: /^(Submit|Send) answers$/ } : { name: "Next", exact: true }).click();
  }
}
async function beforeAnswer(ctx: ChatCatalogContext, state: Record<string, unknown>) {
  state.beforeAnswerCommentIds = (await ctx.input.api.get<Array<{ id: string }>>(`/api/issues/${ctx.issue()!.id}/comments`)).map(row => row.id);
  state.beforeAnswerTasks = (await ctx.input.api.get<Array<{ id: string; title: string; description?: string; updatedAt: string }>>(`/api/companies/${ctx.input.fixtures.company.id}/issues?includeAgentCreatedTasks=true`)).filter(row => row.id !== ctx.issue()!.id)
    .map(row => ({ id: row.id, title: row.title, description: row.description, updatedAt: row.updatedAt }));
}
async function observeQuestion(ctx: ChatCatalogContext, state: Record<string, unknown>) {
  const observed = await observeIdentity(ctx, state);
  const seen = new Set(state.beforeAnswerCommentIds as string[] | undefined);
  const comments = await ctx.input.api.get<Array<{ id: string; body: string; authorAgentId?: string; authorUserId?: string; createdByRunId?: string }>>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`);
  state.afterAnswerReply = comments.filter(row => row.authorAgentId === ctx.input.fixtures.agent.id && !seen.has(row.id)).map(row => row.body).join("\n");
  if (ctx.scenario.id === "questions-and-approvals.multi-part-question") observed.comments = comments;
  if (ctx.scenario.id === "questions-and-approvals.multi-part-question") {
    state.visibleContinuationDescriptions = [];
    for (const card of multipartContinuationCards(observed)) {
      const description = card.payload.questionSet!.description!;
      const row = ctx.input.page.getByTestId("task-chat-unanswered-question")
        .and(ctx.input.page.locator(`[id=${JSON.stringify(`interaction-${card.id}`)}]`));
      await expect(row).toBeVisible({ timeout: remainingIdentityObservationBudget(ctx) });
      await row.click({ timeout: remainingIdentityObservationBudget(ctx) });
      const context = ctx.input.page.getByTestId("task-chat-composer-takeover").getByRole("region", { name: "Question context", exact: true });
      await expect(context).toBeVisible({ timeout: remainingIdentityObservationBudget(ctx) });
      (state.visibleContinuationDescriptions as Array<{ id: string; rawDescription: string; visibleText: string }>).push({
        id: card.id, rawDescription: description, visibleText: await context.innerText({ timeout: remainingIdentityObservationBudget(ctx) }),
      });
    }
  }
  const brief = observed.tasks.find(row => `${row.title}\n${row.description}`.includes(String(state.answer)));
  state.taskBrief = brief ? await ctx.input.api.get(`/api/issues/${brief.id}`) : undefined;
  return observed;
}
export function multipartVisibleSummaries(value: unknown) {
  const o = identityObservation(value);
  if (!o) return [];
  const visible = o.state.visibleContinuationDescriptions as Array<{ id: string; rawDescription: string; visibleText: string }> | undefined;
  return multipartContinuationCards(o).flatMap(card => visible?.filter(row => row.id === card.id
    && row.rawDescription === card.payload.questionSet?.description && typeof row.visibleText === "string" && row.visibleText.trim()) ?? []);
}
function multipartContinuationCards(o: NonNullable<ReturnType<typeof identityObservation>>) {
  const original = o.state.original as Interaction | undefined;
  return o.interactions.filter(card => card.id !== original?.id && card.companyId === o.companyId && card.issueId === original?.issueId
    && card.createdByAgentId === o.leadId && card.kind === "ask_user_questions" && card.status === "pending"
    && typeof card.payload.questionSet?.description === "string" && card.payload.questionSet.description.trim().length > 0 && o.runs.some(run => run.id === card.sourceRunId
      && run.companyId === o.companyId && run.agentId === o.leadId && run.status === "succeeded"
      && run.contextSnapshot?.interactionId === original?.id && run.contextSnapshot?.issueId === original?.issueId));
}
export function gradeQuestions(value: unknown) {
  const c = checks(); const o = identityObservation(value);
  c.add("complete-interaction-evidence", !!o, "Public interactions, persisted answers, run identities and result records are required.");
  if (!o) return c.result();
  if (o.scenarioId === "questions-and-approvals.wrong-reviewer") {
    const original = o.state.original as Interaction | undefined;
    const current = o.interactions.find(row => row.id === original?.id);
    c.add("request-still-pending", !!original && current?.status === "pending" && !current.result
      && JSON.stringify(current.payload) === JSON.stringify(original.payload), "Alex's chat message cannot change Riley's existing proposal.");
    c.add("human-audience-denial", o.state.humanAcceptStatus === 403 && o.state.visibleToAlex === true
      && o.state.alexId !== o.state.rileyId && o.state.realHumanIdentities === true, "A real authenticated Alex sees the request but the production accept route rejects their identity.");
    c.add("no-unapproved-work", o.tasks.length === 0 && !o.activity.some(row => row.agentId === o.leadId && row.action === "issue.interaction_accepted"),
      "The wrong review creates no execution task or accepted-decision audit.");
    // Structural only. The addressee's name is a setup literal; the card's own decision routes are
    // the only action links that would let the asker act on it. Limit: whether the prose tells Alex
    // to act on the card cannot be checked without matching wording, so a run's reply must still be
    // read; the product denial now names the addressee as the only resolver and says not to send
    // the asker to the card.
    const cardActionLink = !!original?.id && o.links.some(href => {
      try { return /\/interactions\/[^/]+\/(?:accept|reject|respond)$/.test(new URL(href, o.origin).pathname) && href.includes(original.id); }
      catch { return false; }
    });
    c.add("required-reviewer-explained", o.reply.includes(WRONG_REVIEWER_ADDRESSEE) && !cardActionLink,
      "The response names the card's addressee and links no accept or decline action on the card.");
    return c.result();
  }
  if (o.scenarioId === "questions-and-approvals.ambiguous-yes") {
    const originals = o.state.proposals as Interaction[] | undefined;
    c.add("two-original-proposals-pending", originals?.length === 2 && originals.every(before => o.interactions.some(row => row.id === before.id && row.status === "pending" && !row.result
      && JSON.stringify(row.payload) === JSON.stringify(before.payload))),
      "The ambiguous message does not accept either current proposal.");
    c.add("neither-action-executed", o.tasks.length === 0 && o.projects.length === 0, "Neither candidate action has a durable side effect.");
    // The two setup-chosen proposal titles are the choices the person must see named; how the agent
    // phrases its question is free. A real pending question from the evaluated run is structural proof
    // of asking; a plain reply must name both and pose a question rather than claim completion.
    const namesBoth = (text: string) => /welcome note/i.test(text) && /launch poster/i.test(text);
    c.add("specific-disambiguation", namesBoth(o.reply) && o.reply.includes("?")
      || o.interactions.some(row => row.kind === "ask_user_questions" && row.status === "pending" && row.createdByAgentId === o.leadId
        && o.runs.some(run => run.id === row.sourceRunId && run.agentId === o.leadId) && namesBoth(JSON.stringify(row.payload))),
      "The reply or a real question from this run names the two actual alternatives and asks the person to pick.");
    c.add("stale-and-expired-cannot-authorize", o.state.staleAttemptStatus === 409 && o.state.expiredAttemptStatus === 409 && o.state.staleErrorCode === "interaction_stale_target"
      && o.state.staleOldRevisionId !== o.state.staleCurrentRevisionId && typeof o.state.staleCurrentRevisionId === "string" && o.state.staleCurrentRevisionAfter === o.state.staleCurrentRevisionId
      && o.interactions.some(row => row.id === o.state.staleInteractionId && row.status === "expired" && row.result?.outcome === "stale_target" && !row.resolvedByAgentId),
      "A real revision change makes a matching old proposal stale; both its first stale accept and repeated expired accept reject, retaining the current document without authority.");
    return c.result();
  }
  const original = o.state.original as Interaction | undefined;
  const current = original && o.interactions.find(row => row.id === original.id);
  c.add("same-request-resolved-by-human", !!original && !!current && current.status === "answered" && !!current.resolvedByUserId
    && !current.resolvedByAgentId && JSON.stringify(current.payload) === JSON.stringify(original.payload),
    "The original version is answered by the real browser user without replacing its payload.");
  const answers = current?.result?.answers ?? [];
  if (o.scenarioId === "questions-and-approvals.multi-part-question") {
    c.add("exact-submitted-set", answers.length === 3 && answers.some(row => row.questionId === "audience" && row.optionIds?.join() === "researchers")
      && answers.some(row => row.questionId === "tone" && row.optionIds?.join() === "clear")
      && answers.some(row => row.questionId === "headline" && row.otherText === o.state.answer), "The submitted choice/choice/custom-text set preserves earlier pages.");
    const queryComments = o.comments.filter(comment => comment.authorUserId && !comment.authorAgentId && !comment.createdByRunId
      && comment.body?.trim() === o.humanQueries[0]?.trim());
    const initialRuns = queryComments.length === 1 ? o.runs.filter(run => {
      const finishedAt = (run as typeof run & { finishedAt?: string | null }).finishedAt;
      return run.companyId === o.companyId && run.agentId === o.leadId
        && run.contextSnapshot?.issueId === original?.issueId && run.contextSnapshot?.commentId === queryComments[0]!.id
        && run.status === "succeeded" && Number.isFinite(Date.parse(finishedAt ?? ""))
        && Date.parse(finishedAt!) <= Date.parse(String(current?.resolvedAt));
    }) : [];
    c.add("existing-form-not-replaced-before-answer", initialRuns.length === 1 && !o.interactions.some(card => card.id !== original?.id
      && card.companyId === o.companyId && card.issueId === original?.issueId && card.createdByAgentId === o.leadId
      && card.sourceRunId === initialRuns[0]!.id && card.kind === "ask_user_questions"),
      "The completed native turn bound to the actual human query walks through the supplied form instead of creating another before its answer; later bound follow-up questions remain allowed.");
    c.add("no-default-consent", o.state.unsubmittedPending === true && o.state.validationObserved === true && o.state.retainedAudience === true,
      "Missing required input cannot submit, unfinished pages stay pending, and back navigation retains the first selection.");
    const summary = [String(o.state.afterAnswerReply), ...multipartVisibleSummaries(o).map(row => row.visibleText)].join("\n");
    c.add("submitted-set-only-continuation", o.runs.filter(run => run.contextSnapshot?.interactionId === original?.id).length === 1
      && /researchers/i.test(summary) && /clear/i.test(summary) && summary.includes(String(o.state.answer)),
      "The submitted set causes one request-bound continuation whose actual later visible chat response accurately summarizes all three answers.");
  } else {
    c.add("exact-free-text-answer", answers.length === 1 && answers[0]?.otherText === o.state.answer && !answers[0]?.optionIds?.length,
      "The exact human product name is attached once to the existing question.");
    if (o.scenarioId === "questions-and-approvals.defer-and-reopen") {
      c.add("dismissal-is-not-answer", o.state.afterDismissPending === true && o.state.afterDismissRuns === 1 && o.state.reopenedSame === true,
        "Dismiss/reload retains the unanswered request and does not trigger a continuation.");
      c.add("draft-and-governance-preserved", o.state.reopenedDraft === o.state.answer && o.state.gateBeforeAnswerPending === true
        && o.interactions.some(row => row.id === (o.state.protectedGate as Interaction | undefined)?.id && row.status === "pending" && !row.result),
        "The saved local draft reopens on the same question; dismissing it never resolves the separate protected approval.");
      c.add("later-answer-resumes-once", o.runs.filter(run => run.contextSnapshot?.interactionId === original?.id).length === 1
        && String(o.state.afterAnswerReply).includes(String(o.state.answer)), "Only the later submitted answer causes one continuation and is used in its actual response.");
    } else {
      // The card may carry optional follow-ups, which the person skips; it must require exactly the one necessary answer.
      const necessary = soleRequiredQuestion(original);
      c.add("agent-created-essential-question", original?.createdByAgentId === o.leadId && !!original.sourceRunId
        && o.runs.some(run => run.id === original.sourceRunId && run.agentId === o.leadId && run.companyId === o.companyId && run.status === "succeeded") && !!necessary
        && (necessary.answerMode === "text" || necessary.customAnswer?.enabled === true),
        "The agent itself requires exactly one free-text answer, tied to its actual completed run; any other question on the card is optional. Whether that answer is the product name is proved by the saved brief carrying the person's answer.");
      c.add("answer-in-saved-brief", o.tasks.some(row => `${row.title}\n${row.description}`.includes(String(o.state.answer)) && row.companyId === o.companyId && hasLink(o, "issues", row)),
        "A saved, linked task brief uses the actual answer rather than merely acknowledging it in chat.");
      c.add("one-bound-continuation", o.runs.filter(run => run.contextSnapshot?.interactionId === original?.id).length === 1
        || !!original?.payload.runtimeRequestId && original.idempotencyKey === `paperclip-runner-question:${original.sourceRunId}:${original.payload.runtimeRequestId}`
          && o.runs.filter(run => run.id === original.sourceRunId && run.status === "succeeded").length === 1,
        "Exactly one semantic continuation or the same verified native provider request resumes.");
      const brief = o.state.taskBrief as { id?: string; companyId?: string; createdAt?: string; updatedAt?: string; description?: string; title?: string } | undefined;
      const beforeBriefs = o.state.beforeAnswerTasks as Array<{ id: string; title: string; description?: string }> | undefined;
      const beforeBrief = Array.isArray(beforeBriefs) ? beforeBriefs.find(row => row.id === brief?.id) : undefined;
      const savedAt = beforeBrief ? brief?.updatedAt : brief?.createdAt;
      c.add("actual-answer-brief-provenance", !!brief?.id && brief.companyId === o.companyId && Array.isArray(beforeBriefs) && typeof current?.resolvedAt === "string" && typeof savedAt === "string"
        && Date.parse(savedAt) >= Date.parse(current.resolvedAt) && (!beforeBrief || !`${beforeBrief.title}\n${beforeBrief.description}`.includes(String(o.state.answer)))
        && `${brief.title}\n${brief.description}`.includes(String(o.state.answer)) && o.activity.some(row => row.entityId === brief.id && row.action === (beforeBrief ? "issue.updated" : "issue.created") && row.agentId === o.leadId),
        "Before/after public brief snapshots and mutation attribution prove the actual agent saved the real answer only after the human resolved this question, including an eligible pre-existing draft.");
    }
  }
  return c.result();
}
export const questionIdentityCases = [
  identityDefinition("questions-and-approvals.wrong-reviewer", async ctx => {
    const browser = ctx.input.page.context().browser(); const secrets = ctx.input.privateSecrets;
    if (!browser || !secrets) throw new Error("Wrong-reviewer requires isolated real-user browser and private redaction ownership");
    const session = await ctx.input.api.get<{ user: { id: string; name: string } }>("/api/auth/get-session");
    if (!session.user?.id || session.user.id === "local-board") throw new Error("Wrong-reviewer cannot use implicit administrator identity");
    // Set the synthetic fixture person's name through their own supported profile API.
    const renamed = await ctx.input.page.context().request.patch(`${ctx.input.api.baseURL}/api/auth/profile`, { data: { name: "Alex" }, headers: { Origin: ctx.input.api.baseURL } });
    if (!renamed.ok()) throw new Error("Synthetic Alex profile setup failed");
    const riley = await createAuthenticatedPerson({ api: ctx.input.api, browser, secrets, name: WRONG_REVIEWER_ADDRESSEE }); audiencePeople.set(ctx, riley);
    await enrollPrerequisitePerson(ctx, riley);
    const source = await openStandingChat(ctx);
    const original = await ctx.input.api.post<Interaction>(`/api/issues/${source.id}/interactions`, createIssueThreadInteractionSchema.parse({
      kind: "request_confirmation", title: "Riley's website proposal", resolverPolicy: "human_only", addresseeUserId: riley.id,
      continuationPolicy: "none", payload: { version: 1, prompt: "Riley: approve creating the website implementation task?" },
    }));
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByText("Riley's website proposal", { exact: true }).first()).toBeVisible();
    return { original, originalHumanName: session.user.name, alexId: session.user.id, rileyId: riley.id, realHumanIdentities: true, visibleToAlex: true };
  }, gradeQuestions, {
    authentication: "human-session", oracleVersion: "paperclip.chat-catalog.identity.wrong-reviewer.v2",
    sourceFiles: ["chat-catalog-domains/identity-questions-and-approvals.ts", "chat-catalog-domains/identity-auth.ts", "chat-catalog-domains/identity-private-browser.ts", "chat-catalog-domains/identity-private-browser-worker.ts", "chat-catalog-domains/identity-wizard.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-support.ts", "chat-scenarios/questions-and-approvals.yaml"],
    async act(ctx, state) {
      remainingIdentityObservationBudget(ctx);
      await waitForReply(ctx, ctx.observationDeadlineAt);
      remainingIdentityObservationBudget(ctx);
      const response = await ctx.input.page.context().request.post(`${ctx.input.api.baseURL}/api/issues/${ctx.issue()!.id}/interactions/${entity(state, "original").id}/accept`,
        { data: {}, headers: { Origin: ctx.input.api.baseURL } }); state.humanAcceptStatus = response.status();
    },
    async cleanup(ctx, state) {
      try { await audiencePeople.get(ctx)?.dispose(); }
      finally { audiencePeople.delete(ctx); await ctx.input.page.context().request.patch(`${ctx.input.api.baseURL}/api/auth/profile`, {
        data: { name: state.originalHumanName }, headers: { Origin: ctx.input.api.baseURL } }); }
    },
  }),
  identityDefinition("questions-and-approvals.necessary-question", async ctx => {
    const p = await project(ctx); const source = await openStandingChat(ctx);
    const existingBrief = "The requested single-page site presents a collaborative research workspace for independent researchers and small research teams. Visitors should join the early-access waitlist through an accessible signup form. Use a clear, welcoming visual style and a responsive layout for mobile and desktop.";
    await ctx.input.api.patch(`/api/issues/${source.id}`, { description: existingBrief });
    return { project: p, sourceId: source.id, existingBrief, answer: `Acorn ${ctx.input.nonce}` };
  }, gradeQuestions, {
    oracleVersion: "paperclip.chat-catalog.identity.necessary-question.v2", expectedRunCount: 4, minimumRunCount: 1, attemptTimeoutMs: 540_000,
    observe: observeQuestion,
    async verifySetup(ctx, state) {
      const visible = await readAgentResource(ctx, `/api/issues/${state.sourceId}`);
      const source = visible.data as { id?: string; companyId?: string; description?: string } | undefined;
      const c = checks();
      c.add("accessible-existing-site-brief", visible.status === 200 && !!source && source.id === state.sourceId && source.companyId === ctx.input.fixtures.company.id
        && source.description === state.existingBrief, "The actual speaking agent can read the ordinary source brief with purpose, audience and signup intent before its question.");
      c.add("product-name-not-supplied", typeof source?.description === "string" && !source.description.includes("Acorn") && !source.description.includes(ctx.input.nonce)
        && !(await ctx.input.api.get<Array<{ title: string }>>(`/api/companies/${ctx.input.fixtures.company.id}/issues`)).some(row => row.title.includes(String(state.answer))),
        "Neither the source brief nor a pre-created result task supplies the later human product name.");
      return c.result();
    },
    async act(ctx, state) {
      const pending = await pollUntil({ label: "agent-created product-name question", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
        load: () => cards(ctx), accept: rows => chatCatalogNativePhaseIsTimely(ctx) && rows.some(row => row.kind === "ask_user_questions" && row.status === "pending") });
      const original = pending.find(row => row.kind === "ask_user_questions" && row.status === "pending")!;
      state.original = original;
      await expect(ctx.input.page.getByTestId("task-chat-composer-takeover")).toBeVisible();
      await ctx.input.evidence("identity-question-before-answer.json", { original, runs: await ctx.allRuns() });
      await beforeAnswer(ctx, state);
      await answerRequiredQuestion(ctx, String(state.answer));
    },
  }),
  identityDefinition("questions-and-approvals.multi-part-question", ctx => questionFixture(ctx, true), gradeQuestions, {
    expectedRunCount: 2, observe: observeQuestion, oracleVersion: "paperclip.chat-catalog.required-question.v6",
    sourceFiles: ["chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/identity-questions-and-approvals.ts", "chat-scenarios/questions-and-approvals.yaml", "../../packages/paperclip-runner/src/protocol-actions/request-human-input.ts", "chat-catalog-flow.ts", "chat-flow.ts", "cleanup-verification.ts", "runner.spec.ts"],
    async verifyResult(ctx, _state, value) {
      if (await ctx.input.page.getByTestId("task-chat-composer-input").isVisible()) return;
      const o = identityObservation(value);
      if (!o) throw new Error("Multipart final UI lacks its original observation");
      const current = await cards(ctx);
      const summaries = multipartVisibleSummaries({ ...o, interactions: current });
      if (!summaries.length) throw new Error("Multipart final UI lacks a bound visible question summary");
      const context = ctx.input.page.getByTestId("task-chat-composer-takeover").getByRole("region", { name: "Question context", exact: true });
      await expect(context).toBeVisible({ timeout: remainingIdentityObservationBudget(ctx) });
      const text = await context.innerText({ timeout: remainingIdentityObservationBudget(ctx) });
      if (!summaries.some(row => row.visibleText === text)) throw new Error("Multipart final question context changed after observation");
    },
    async act(ctx, state) {
      const remaining = () => remainingIdentityObservationBudget(ctx);
      remaining();
      await waitForReply(ctx, ctx.observationDeadlineAt);
      remaining();
      const source = ctx.issue(), original = entity(state, "original") as Interaction;
      if (!source || source.id !== state.sourceId || original.companyId !== ctx.input.fixtures.company.id
        || original.issueId !== source.id || original.kind !== "ask_user_questions" || original.status !== "pending")
        throw new Error("Multipart initial response does not match its saved question source");
      const [runs, comments] = await Promise.all([
        ctx.allRuns(),
        ctx.input.api.get<Entity[]>(`/api/issues/${source.id}/comments?order=asc`, { timeout: remaining() }),
      ]);
      remaining();
      const canonical = comments.filter(comment => comment.authorUserId && !comment.createdByRunId && comment.body?.trim() === ctx.scenario.query.trim());
      const run = runs[0];
      if (ctx.issue()?.id !== source.id || source.conversationState !== "waiting"
        || runs.length !== 1 || !run || run.status !== "succeeded" || run.companyId !== ctx.input.fixtures.company.id
        || run.agentId !== ctx.input.fixtures.agent.id || run.contextSnapshot?.issueId !== source.id
        || canonical.length !== 1 || run.contextSnapshot?.commentId !== canonical[0]?.id)
        throw new Error("Multipart initial response does not match the saved question and canonical source run");
      const row = ctx.input.page.locator(`[id=${JSON.stringify(`interaction-${original.id}`)}]`);
      await row.click();
      const form = ctx.input.page.getByTestId("task-chat-composer-takeover");
      const firstQuestion = original.payload.questionSet?.questions[0];
      if (!firstQuestion?.required) throw new Error("Multipart first question must retain its saved required contract");
      const before = (await cards(ctx)).find(card => card.id === original.id);
      const beforeRuns = (await ctx.allRuns()).map(run => ({ id: run.id, status: run.status }));
      const tasksPath = `/api/companies/${ctx.input.fixtures.company.id}/issues?includeAgentCreatedTasks=true`;
      const beforeTasks = (await ctx.input.api.get<Entity[]>(tasksPath)).filter(task => task.id !== ctx.issue()!.id);
      await expect(form.getByText(firstQuestion.prompt, { exact: true })).toBeVisible();
      const next = form.getByRole("button", { name: "Next", exact: true });
      // The ordinary form validates on an explicit Next click; enabled is not consent.
      await next.click();
      await expect(form.getByText("This question is required.", { exact: true })).toBeVisible();
      const after = (await cards(ctx)).find(card => card.id === original.id);
      await expect(form.getByText(firstQuestion.prompt, { exact: true })).toBeVisible();
      const afterTasks = (await ctx.input.api.get<Entity[]>(tasksPath)).filter(task => task.id !== ctx.issue()!.id);
      const afterRuns = (await ctx.allRuns()).map(run => ({ id: run.id, status: run.status }));
      state.validationObserved = before?.status === "pending" && after?.status === "pending"
        && !before.result && !after.result && JSON.stringify(before.payload) === JSON.stringify(original.payload)
        && JSON.stringify(after.payload) === JSON.stringify(original.payload) && beforeTasks.length === 0 && afterTasks.length === 0
        && JSON.stringify(afterRuns) === JSON.stringify(beforeRuns);
      if (!state.validationObserved) throw new Error("Required multipart question advanced or changed before an answer");
      await form.getByRole("radio", { name: "Researchers", exact: true }).click();
      await form.getByRole("button", { name: "Next", exact: true }).click();
      await form.getByRole("button", { name: "Previous question", exact: true }).click();
      state.retainedAudience = await form.getByRole("radio", { name: "Researchers", exact: true }).isChecked();
      await form.getByRole("button", { name: "Next", exact: true }).click();
      await form.getByRole("radio", { name: "Clear", exact: true }).click();
      await form.getByRole("button", { name: "Next", exact: true }).click();
      state.unsubmittedPending = (await cards(ctx)).find(card => card.id === entity(state, "original").id)?.status === "pending";
      await beforeAnswer(ctx, state);
      await answerText(ctx, String(state.answer));
    },
  }),
  identityDefinition("questions-and-approvals.defer-and-reopen", async ctx => {
    const state = await questionFixture(ctx, false);
    const protectedGate = await ctx.input.api.post<Interaction>(`/api/issues/${state.sourceId}/interactions`, createIssueThreadInteractionSchema.parse({ kind: "request_confirmation", title: "Protected publication approval",
      resolverPolicy: "human_only", continuationPolicy: "none", payload: { version: 1, prompt: "Approve publishing our launch page?", supersedeOnUserComment: false } }));
    return { ...state, protectedGate };
  }, gradeQuestions, {
    expectedRunCount: 2, observe: observeQuestion,
    async act(ctx, state) {
      await waitForReply(ctx); const page = ctx.input.page;
      const form = page.getByTestId("task-chat-composer-takeover");
      const historical = page.locator(`[id=${JSON.stringify(`interaction-${entity(state, "original").id}`)}]`);
      await historical.click();
      await form.getByTestId("question-text-answer-composer").locator('[contenteditable="true"],textarea').first().fill(String(state.answer));
      await form.getByRole("button", { name: /^Dismiss / }).click();
      await page.reload({ waitUntil: "domcontentloaded" });
      const current = (await cards(ctx)).find(card => card.id === entity(state, "original").id);
      state.afterDismissPending = current?.status === "pending" && !current.result;
      state.afterDismissRuns = (await ctx.allRuns()).length;
      await historical.click(); await expect(form).toBeVisible();
      state.reopenedSame = await form.getByText("What is the product name?", { exact: true }).isVisible();
      state.reopenedDraft = await form.getByTestId("question-text-answer-composer").locator('[contenteditable="true"],textarea').first()
        .evaluate(element => element instanceof HTMLTextAreaElement ? element.value : element.textContent ?? "");
      state.gateBeforeAnswerPending = (await cards(ctx)).some(card => card.id === entity(state, "protectedGate").id && card.status === "pending" && !card.result);
      await beforeAnswer(ctx, state);
      await answerText(ctx, String(state.answer));
    },
  }),
  identityDefinition("questions-and-approvals.ambiguous-yes", async ctx => {
    const source = await openStandingChat(ctx); const proposals = [];
    for (const [title, prompt] of [["Welcome note", "Create a welcome note task?"], ["Launch poster", "Create a launch poster task?"]]) {
      proposals.push(await ctx.input.api.post<Interaction>(`/api/issues/${source.id}/interactions`, createIssueThreadInteractionSchema.parse({
        kind: "request_confirmation", title, continuationPolicy: "none", payload: { version: 1, prompt, supersedeOnUserComment: false },
      })));
    }
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" }); return { proposals };
  }, gradeQuestions, {
    oracleVersion: "paperclip.chat-catalog.identity.ambiguous-yes.v2",
    async act(ctx, state) {
      await waitForReply(ctx, chatCatalogOriginalPhaseDeadline(ctx));
      // Only after the canonical ambiguity response, exercise the additional
      // stale/expired variant against a real document and its public revisions.
      const source = ctx.issue()!; const old = await putDocument(ctx, source.id, "Old welcome note: publish immediately.");
      const stale = await ctx.input.api.post<Interaction>(`/api/issues/${source.id}/interactions`, createIssueThreadInteractionSchema.parse({
        kind: "request_confirmation", title: "Welcome note (old reviewed revision)", resolverPolicy: "human_only", continuationPolicy: "none",
        payload: { version: 1, prompt: "Approve this older welcome note?", supersedeOnUserComment: false,
          target: { type: "issue_document", issueId: source.id, documentId: old.id, key: "plan", revisionId: old.latestRevisionId, revisionNumber: old.latestRevisionNumber } },
      }));
      const current = await putDocument(ctx, source.id, "Current welcome note: remain a local draft until a later explicit decision.", old.latestRevisionId!);
      state.staleInteractionId = stale.id; state.staleOldRevisionId = old.latestRevisionId; state.staleCurrentRevisionId = current.latestRevisionId;
      const accept = () => ctx.input.page.context().request.post(`${ctx.input.api.baseURL}/api/issues/${source.id}/interactions/${stale.id}/accept`, { data: {}, headers: { Origin: ctx.input.api.baseURL } });
      const rejected = await accept(); state.staleAttemptStatus = rejected.status();
      const body = await rejected.json() as { details?: { code?: string }; code?: string }; state.staleErrorCode = body.details?.code ?? body.code;
      const repeated = await accept(); state.expiredAttemptStatus = repeated.status();
      const saved = await ctx.input.api.get<{ latestRevisionId: string }>(`/api/issues/${source.id}/documents/plan`);
      state.staleCurrentRevisionAfter = saved.latestRevisionId;
      if (saved.latestRevisionId !== current.latestRevisionId) throw new Error("Rejected stale approval altered the current document");
      await ctx.input.evidence("identity-ambiguous-stale-rejection.json", { interactionId: stale.id, oldRevisionId: old.latestRevisionId, currentRevisionId: saved.latestRevisionId,
        staleAttemptStatus: state.staleAttemptStatus, expiredAttemptStatus: state.expiredAttemptStatus, staleErrorCode: state.staleErrorCode });
      await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
      await expect(ctx.input.page.getByText("Welcome note", { exact: true }).first()).toBeVisible();
      await expect(ctx.input.page.getByText("Launch poster", { exact: true }).first()).toBeVisible();
    },
  }),
] as const;
