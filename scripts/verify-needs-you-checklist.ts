/**
 * scripts/verify-needs-you-checklist.ts
 *
 * PAP-749 final check: walks the plan's section 7 "things to try" checklist,
 * plus the task 1d escalation owners and the PAP-768 additions (P1 Everyone,
 * P2 personal history, P3 one budget-stop card), through the real HTTP API as each demo
 * user (Scott, Dotta, Riley). It signs in with the demo password, so it needs a
 * running server in `authenticated` mode whose database holds a FRESH run of
 * scripts/seed-needs-you-demo.ts (default seed options).
 *
 * It CHANGES the demo data (withdraw, transfer, claim, archive/restore,
 * withdraw all stale, keep a budget stop paused). Re-run the seed afterwards
 * to give a reviewer the untouched demo.
 *
 *   BASE_URL=http://127.0.0.1:3200 \
 *     pnpm --filter @paperclipai/server exec tsx ../scripts/verify-needs-you-checklist.ts
 *
 * What it cannot prove: anything a browser shows (the live update without a
 * reload, the confirmation dialogs, the classic page's layout). Those steps are
 * reported as API-level checks only.
 */
import type { AttentionFeed, AttentionItem, AttentionReceipt, DecisionHistoryItem } from "../packages/shared/src/index.js";

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:3200").replace(/\/$/, "");
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "needs-you-demo-2026";
const DEMO_COMPANY_NAME = "Needs You Demo";
const USERS = {
  scott: "scott@needs-you-demo.test",
  dotta: "dotta@needs-you-demo.test",
  riley: "riley@needs-you-demo.test",
} as const;
type UserKey = keyof typeof USERS;

type Session = { key: UserKey; userId: string; cookie: string };
type View = "mine" | "unassigned" | "company" | "archived" | "all";

const results: Array<{ step: string; ok: boolean; detail: string }> = [];
function check(step: string, ok: boolean, detail: string) {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step} — ${detail}`);
}

async function http<T>(session: Session | null, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      Origin: BASE_URL,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(session ? { Cookie: session.cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json: json as T };
}

async function signIn(key: UserKey): Promise<Session> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Origin: BASE_URL },
    body: JSON.stringify({ email: USERS[key], password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`sign-in for ${key} failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const session = await http<{ user?: { id: string } }>({ key, userId: "", cookie }, "GET", "/api/auth/get-session");
  const userId = session.json?.user?.id;
  if (!userId) throw new Error(`no session user for ${key}`);
  return { key, userId, cookie };
}

let companyId = "";
async function feed(session: Session, view: View): Promise<AttentionFeed> {
  const res = await http<AttentionFeed>(session, "GET", `/api/companies/${companyId}/attention?all=true&view=${view}`);
  if (res.status !== 200) throw new Error(`feed ${view} for ${session.key}: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

/** The cards a page shows: obligation evidence folds into its lead (task 2d). */
function leads(items: AttentionItem[]) {
  return items.filter((item) => !item.obligationLeadId || item.obligationLeadId === item.id);
}
const has = (items: AttentionItem[], id: string) => items.some((item) => item.id === id);
const titleOf = (item: AttentionItem | undefined) => item?.subject.title ?? "(none)";

async function close(session: Session, item: AttentionItem, body: Record<string, unknown>) {
  return http<unknown>(session, "POST", `/api/companies/${companyId}/attention/${item.sourceKind}/${item.subject.id}/close`, body);
}

async function main() {
  console.log(`[verify] ${BASE_URL}`);
  const scott = await signIn("scott");
  const dotta = await signIn("dotta");
  const riley = await signIn("riley");
  const name = (userId: string | null | undefined) =>
    [scott, dotta, riley].find((session) => session.userId === userId)?.key ?? userId ?? "nobody";

  const companies = await http<Array<{ id: string; name: string }>>(scott, "GET", "/api/companies");
  const company = companies.json.find((entry) => entry.name === DEMO_COMPANY_NAME);
  if (!company) throw new Error("demo company not found; run the seed first");
  companyId = company.id;
  console.log(`[verify] company ${companyId}`);

  // 1. Each For you list is different, and the badge agrees with the list.
  const mine = { scott: await feed(scott, "mine"), dotta: await feed(dotta, "mine"), riley: await feed(riley, "mine") };
  const scottIds = new Set(mine.scott.items.map((item) => item.id));
  const overlap = mine.dotta.items.filter((item) => scottIds.has(item.id));
  check("1 For you differs", mine.scott.items.length > 0 && mine.dotta.items.length > 0 && overlap.length === 0,
    `Scott ${mine.scott.items.length} cards, Dotta ${mine.dotta.items.length}, shared ${overlap.length}; Riley ${mine.riley.items.length}`);
  for (const [key, data] of Object.entries(mine)) {
    const shown = leads(data.items).length;
    check(`1 badge = list (${key})`, data.deskBadgeCount === data.viewCounts.mine && data.viewCounts.mine === shown,
      `badge ${data.deskBadgeCount}, For you tab ${data.viewCounts.mine}, cards shown ${shown}`);
  }
  check("1 every For you card is the viewer's", (["scott", "dotta", "riley"] as const).every((key) =>
    mine[key].items.every((item) => item.audience.userId === { scott, dotta, riley }[key].userId)), "audience.userId matches the viewer");

  // Task 1d: escalation owners.
  const hardStop = mine.scott.items.find((item) => item.sourceKind === "budget_alert");
  check("1d budget owner card", hardStop?.audience.reason === "budget_owner" && hardStop.audience.alsoInCompany === true
    && hardStop.decisionVerbs.map((verb) => verb.label).join("/") === "Raise limit/Keep paused",
  `Scott For you: "${titleOf(hardStop)}" (${hardStop?.audience.reason}; ${hardStop?.decisionVerbs.map((verb) => verb.label).join(" / ")})`);
  const companyViews = { scott: await feed(scott, "company"), dotta: await feed(dotta, "company"), riley: await feed(riley, "company") };
  check("1d Company still shows the hard stop", Boolean(hardStop) && Object.values(companyViews).every((data) => has(data.items, hardStop!.id)),
    "in Company for Scott, Dotta and Riley (as For @scott for the other two)");
  check("1d hard stop only in the owner's For you", Boolean(hardStop) && !has(mine.dotta.items, hardStop!.id) && !has(mine.riley.items, hardStop!.id),
    "not in Dotta's or Riley's For you");
  const warning = companyViews.scott.items.find((item) => item.sourceKind === "budget_alert" && item.subject.metadata?.thresholdType === "soft");
  check("1d budget warning stays Company only", warning?.audience.kind === "company", `"${titleOf(warning)}" audience ${warning?.audience.kind}`);
  // PAP-768 part 3: the hard stop and its override approval are one card. The
  // stop leads; the approval is its evidence and is no longer an ownerless
  // card in Unassigned.
  const overrideApprovalId = (hardStop?.subject.metadata as { approvalId?: string | null } | null)?.approvalId ?? null;
  const overrideEvidence = mine.scott.items.find((item) => item.sourceKind === "approval" && item.subject.id === overrideApprovalId);
  check("P3 one card for the budget stop", Boolean(hardStop && overrideEvidence) && overrideEvidence!.obligationLeadId === hardStop!.id
    && has(leads(mine.scott.items), hardStop!.id) && !has(leads(mine.scott.items), overrideEvidence!.id),
  `Scott For you: "${titleOf(hardStop)}" leads; "${titleOf(overrideEvidence)}" folded in (lead ${overrideEvidence?.obligationLeadId === hardStop?.id ? "the stop" : overrideEvidence?.obligationLeadId ?? "none"})`);
  const pools = { scott: await feed(scott, "unassigned"), dotta: await feed(dotta, "unassigned"), riley: await feed(riley, "unassigned") };
  check("P3 override approval not in Unassigned", Boolean(overrideApprovalId)
    && Object.values(pools).every((data) => !data.items.some((item) => item.subject.id === overrideApprovalId)),
  `not in Scott's, Dotta's or Riley's Unassigned (${Object.values(pools).map((data) => data.viewCounts.unassigned).join("/")} cards)`);
  check("P3 the stop counts once", Object.values(companyViews).every((data) => data.items.filter((item) => item.subject.id === overrideApprovalId)
    .every((item) => item.obligationLeadId === hardStop?.id)) && mine.scott.viewCounts.mine === leads(mine.scott.items).length,
  "in Company the approval is evidence of the stop; For you counts the stop once");

  const projectCard = mine.dotta.items.find((item) => item.audience.reason === "project_owner");
  check("1d project decision owner", Boolean(projectCard), `Dotta For you: "${titleOf(projectCard)}" (project_owner)`);

  // PAP-768 part 1: Everyone (view=all) for board members, with its own count.
  const scottAll = await feed(scott, "all");
  const access = await http<{ memberships?: Array<{ companyId: string; membershipRole: string | null; status: string }> }>(scott, "GET", "/api/cli-auth/me");
  const scottMembership = access.json?.memberships?.find((entry) => entry.companyId === companyId && entry.status === "active");
  check("P1 Scott is a board member who sees Everyone", Boolean(scottMembership?.membershipRole && scottMembership.membershipRole !== "viewer"),
    `role ${scottMembership?.membershipRole ?? "none"}`);
  check("P1 Everyone count is its own, not the badge", scottAll.viewCounts.all === leads(scottAll.items).length
    && scottAll.deskBadgeCount === scottAll.viewCounts.mine && scottAll.viewCounts.all > scottAll.viewCounts.mine,
  `Everyone tab ${scottAll.viewCounts.all}, cards ${leads(scottAll.items).length}, badge ${scottAll.deskBadgeCount} (For you ${scottAll.viewCounts.mine})`);
  const othersInEveryone = leads(scottAll.items).filter((item) => item.audience.kind === "user" && item.audience.userId && item.audience.userId !== scott.userId);
  check("P1 Everyone shows other people's cards", othersInEveryone.some((item) => item.audience.userId === dotta.userId),
    `${othersInEveryone.length} cards for others (${[...new Set(othersInEveryone.map((item) => name(item.audience.userId)))].join(", ")}); the UI shows each as "For @name"`);

  // 2. As Scott, withdraw a card for Dotta from Everyone; Dotta gets the
  // receipt. Cards addressed to Dotta stay out of Scott's feed (the
  // pre-PAP-749 addressee filter), so these are her instigator and
  // project-owner cards; the project-owner card goes last so the task 1d demo
  // card survives step 2.
  const dottaCards = scottAll.items
    .filter((item) => item.audience.userId === dotta.userId
      && item.sourceKind === "issue_thread_interaction" && item.closeModes.includes("withdraw") && !item.stale)
    .sort((left, right) => Number(left.audience.reason === "project_owner") - Number(right.audience.reason === "project_owner"));
  const toWithdraw = dottaCards[0];
  if (!toWithdraw) throw new Error("no withdrawable card for Dotta");
  const withdraw = await close(scott, toWithdraw, { mode: "withdraw", reason: "Out of date (checklist step 2)" });
  const dottaAfterWithdraw = await feed(dotta, "mine");
  const withdrawReceipt = (dottaAfterWithdraw.receipts ?? []).find((receipt: AttentionReceipt) => receipt.sourceId === toWithdraw.subject.id);
  check("2 withdraw for Dotta (from Everyone)", withdraw.status === 200 && !has(dottaAfterWithdraw.items, toWithdraw.id)
    && withdrawReceipt?.outcome === "withdrawn" && withdrawReceipt.actorUserId === scott.userId,
  `"${titleOf(toWithdraw)}" -> ${withdraw.status}; Dotta receipt: ${withdrawReceipt ? `${withdrawReceipt.outcome} by ${name(withdrawReceipt.actorUserId)} (reason: ${withdrawReceipt.reason})` : "none"}`);

  // 3. As Scott, transfer a card to Riley; it shows in Riley's For you.
  const toTransfer = dottaCards.find((item) => item.id !== toWithdraw.id);
  if (!toTransfer) throw new Error("no second card for Dotta to transfer");
  const transfer = await http<unknown>(scott, "POST", `/api/companies/${companyId}/attention/${toTransfer.sourceKind}/${toTransfer.subject.id}/transfer`, {
    userId: riley.userId, reason: "Riley owns this now (checklist step 3)",
  });
  const rileyAfter = await feed(riley, "mine");
  const transferred = rileyAfter.items.find((item) => item.subject.id === toTransfer.subject.id);
  const dottaAfterTransfer = await feed(dotta, "mine");
  const transferReceipt = (dottaAfterTransfer.receipts ?? []).find((receipt: AttentionReceipt) => receipt.sourceId === toTransfer.subject.id);
  check("3 transfer to Riley", transfer.status === 200 && transferred?.audience.transferredByUserId === scott.userId
    && !has(dottaAfterTransfer.items, toTransfer.id) && transferReceipt?.outcome === "transferred",
  `"${titleOf(toTransfer)}" -> ${transfer.status}; Riley For you: ${transferred ? `yes, "Transferred by @${name(transferred.audience.transferredByUserId)}"` : "no"}; Dotta receipt: ${transferReceipt?.outcome ?? "none"}`);

  // 4. As Scott, claim an Unassigned card; it leaves Dotta's Unassigned.
  const scottPool = await feed(scott, "unassigned");
  const toClaim = scottPool.items.find((item) => item.sourceKind === "issue_thread_interaction");
  if (!toClaim) throw new Error("no claimable Unassigned card");
  const dottaPoolBefore = await feed(dotta, "unassigned");
  const claim = await http<unknown>(scott, "POST", `/api/companies/${companyId}/attention/${toClaim.sourceKind}/${toClaim.subject.id}/claim`, {});
  const dottaPoolAfter = await feed(dotta, "unassigned");
  const scottMineAfterClaim = await feed(scott, "mine");
  check("4 claim from Unassigned", claim.status === 200 && has(dottaPoolBefore.items, toClaim.id) && !has(dottaPoolAfter.items, toClaim.id)
    && has(scottMineAfterClaim.items, toClaim.id),
  `"${titleOf(toClaim)}" -> ${claim.status}; Dotta Unassigned ${dottaPoolBefore.viewCounts.unassigned} -> ${dottaPoolAfter.viewCounts.unassigned}; now in Scott's For you`);

  // 5. Archive a card; it shows in Archived; Restore works; Dotta still sees it.
  const scottCompany = await feed(scott, "company");
  const toArchive = scottCompany.items.find((item) => item.sourceKind === "agent_error_alert") ?? scottCompany.items[0];
  if (!toArchive) throw new Error("no Company card to archive");
  const archive = await close(scott, toArchive, { mode: "archive", fingerprint: toArchive.changeFingerprint });
  const scottArchived = await feed(scott, "archived");
  const scottCompanyAfter = await feed(scott, "company");
  const dottaCompanyAfter = await feed(dotta, "company");
  check("5 archive for me", archive.status === 200 && has(scottArchived.items, toArchive.id) && !has(scottCompanyAfter.items, toArchive.id)
    && has(dottaCompanyAfter.items, toArchive.id),
  `"${titleOf(toArchive)}" -> ${archive.status}; in Scott's Archived (tab ${scottArchived.viewCounts.archived}); Dotta still sees it`);
  const restore = await http<unknown>(scott, "DELETE", `/api/companies/${companyId}/inbox-dismissals/${encodeURIComponent(toArchive.dismissalKey)}`);
  const scottCompanyRestored = await feed(scott, "company");
  const scottArchivedRestored = await feed(scott, "archived");
  check("5 restore", restore.status >= 200 && restore.status < 300 && has(scottCompanyRestored.items, toArchive.id) && !has(scottArchivedRestored.items, toArchive.id),
    `restore -> ${restore.status}; back in Scott's Company view`);

  // 6. Withdraw all stale: only non-required cards with a real withdraw close.
  const scottMine = await feed(scott, "mine");
  const stale = leads(scottMine.items).filter((item) => item.stale);
  const withdrawable = stale.filter((item) => item.closeModes.includes("withdraw") && !item.required);
  const kept = stale.filter((item) => !withdrawable.includes(item));
  const statuses: number[] = [];
  for (const item of withdrawable) statuses.push((await close(scott, item, { mode: "withdraw", reason: "Withdraw all stale (checklist step 6)" })).status);
  const scottMineAfterStale = await feed(scott, "mine");
  check("6 withdraw all stale", stale.length > 0 && statuses.every((status) => status === 200)
    && withdrawable.every((item) => !has(scottMineAfterStale.items, item.id)) && kept.every((item) => has(scottMineAfterStale.items, item.id)),
  `Stale (${stale.length}): withdrew ${withdrawable.length} [${statuses.join(",")}], kept ${kept.length} (${kept.map((item) => item.required ? "required" : "no withdraw").join(", ") || "none"})`);

  // 7. The stale approval is in Company with "Waiting 30+ days", still pending.
  const companyNow = await feed(dotta, "company");
  const staleApproval = companyNow.items.find((item) => item.sourceKind === "approval" && item.stale?.reason === "aged");
  check("7 stale approval escalated, not withdrawn", staleApproval?.subject.status === "pending" && staleApproval.required === true,
    `"${titleOf(staleApproval)}" in Company, stale ${staleApproval?.stale?.reason}, status ${staleApproval?.subject.status}`);

  // 8. Decision history filters.
  type History = { items: Array<Pick<DecisionHistoryItem, "sourceKind" | "sourceId" | "label" | "reason" | "action" | "resolvedByUserId" | "handledForUserId">> };
  const history = async (session: Session, query: string) =>
    (await http<History>(session, "GET", `/api/companies/${companyId}/attention/history?limit=100&${query}`)).json.items;
  const withdrawn = await history(scott, "outcome=withdrawn");
  const expired = await history(scott, "outcome=expired");
  const closedWithTask = await history(scott, "outcome=issue_closed");
  const handledForDotta = await history(dotta, "handledForMe=true");
  check("8 history Withdrawn", withdrawn.some((item) => item.sourceId === toWithdraw.subject.id), `${withdrawn.length} entries, includes step 2`);
  check("8 history Expired", expired.length > 0, `${expired.length} entries`);
  check("8 history Closed with task", closedWithTask.length > 0, `${closedWithTask.length} entries`);
  check("8 history Handled for me (Dotta)", handledForDotta.some((item) => item.sourceId === toWithdraw.subject.id), `${handledForDotta.length} entries, includes step 2`);

  // PAP-768 part 2: history opens on "Handled by me or for me" (scope=mine,
  // what both pages ask for first); Everyone (scope=all) is every person's.
  // The board's case: Scott answers the confirmation on "Scott: task you
  // created"; it must stay out of Dotta's default history.
  const ownTaskCard = (await feed(scott, "mine")).items.find((item) => item.sourceKind === "issue_thread_interaction"
    && item.relatedIssue?.title === "Scott: task you created");
  if (!ownTaskCard?.relatedIssue) throw new Error("no confirmation on \"Scott: task you created\" in Scott's For you");
  const accept = await http<unknown>(scott, "POST", `/api/issues/${ownTaskCard.relatedIssue.id}/interactions/${ownTaskCard.subject.id}/accept`, {});
  const ownTaskRow = (items: History["items"]) => items.some((item) => item.sourceId === ownTaskCard.subject.id);
  const scottMineHistory = await history(scott, "scope=mine");
  const dottaMineHistory = await history(dotta, "scope=mine");
  const dottaEveryoneHistory = await history(dotta, "scope=all");
  check("P2 Scott's own answer is in his history", accept.status === 200 && ownTaskRow(scottMineHistory),
    `accept "${ownTaskCard.relatedIssue.identifier} · ${ownTaskCard.relatedIssue.title}" -> ${accept.status}; in Scott's Handled by me or for me`);
  check("P2 Dotta's default history leaves it out", !ownTaskRow(dottaMineHistory),
    `Dotta Handled by me or for me: ${dottaMineHistory.length} entries, none on ${ownTaskCard.relatedIssue.identifier}`);
  check("P2 Dotta's Everyone history shows it", ownTaskRow(dottaEveryoneHistory),
    `Dotta Everyone: ${dottaEveryoneHistory.length} entries, includes ${ownTaskCard.relatedIssue.identifier} · Scott: task you created`);
  check("P2 Dotta's history is hers", dottaMineHistory.length > 0 && dottaMineHistory.length < dottaEveryoneHistory.length,
    `${dottaMineHistory.length} of ${dottaEveryoneHistory.length} entries`);
  const dottaMineWithdrawn = await history(dotta, "scope=mine&outcome=withdrawn");
  const dottaMineHandled = await history(dotta, "scope=mine&handledForMe=true");
  const scottMineExpired = await history(scott, "scope=mine&outcome=expired");
  check("P2 outcome filters work inside each scope", dottaMineWithdrawn.some((item) => item.sourceId === toWithdraw.subject.id)
    && dottaMineHandled.some((item) => item.sourceId === toWithdraw.subject.id) && scottMineExpired.length > 0,
  `Dotta mine + Withdrawn ${dottaMineWithdrawn.length} (step 2 withdraw for her), mine + Handled for me ${dottaMineHandled.length}; Scott mine + Expired ${scottMineExpired.length}`);

  // 9. The classic Decisions page reads the same per-person feed (`all=true&view=`).
  const classic = await feed(dotta, "mine");
  check("9 classic page feed (API only)", classic.deskBadgeCount === classic.viewCounts.mine,
    "same endpoint and query as Needs You; its layout needs a browser");

  // Task 1d: Dotta keeps Scott's hard stop paused; Scott gets the receipt.
  if (hardStop) {
    const resolve = await http<unknown>(dotta, "POST", `/api/companies/${companyId}/budget-incidents/${hardStop.subject.id}/resolve`, { action: "keep_paused" });
    const scottAfterBudget = await feed(scott, "mine");
    const budgetReceipt = (scottAfterBudget.receipts ?? []).find((receipt: AttentionReceipt) => receipt.sourceId === hardStop.subject.id);
    const companyAfterBudget = await feed(riley, "company");
    check("1d receipt for the budget owner", resolve.status === 200 && budgetReceipt?.actorUserId === dotta.userId
      && budgetReceipt.outcome === "kept_paused"
      && !has(scottAfterBudget.items, hardStop.id) && !has(companyAfterBudget.items, hardStop.id),
    `Keep paused by Dotta -> ${resolve.status}; Scott receipt: ${budgetReceipt ? `${budgetReceipt.outcome} by ${name(budgetReceipt.actorUserId)} -> ${budgetReceipt.href}` : "none"}`);
    // PAP-767: the same action is in Scott's "Handled for me" history as the
    // hard stop's approval, kept paused by Dotta for Scott.
    const approvalId = overrideApprovalId;
    const overrideAfter = approvalId ? await http<{ status?: string; decidedByUserId?: string | null }>(scott, "GET", `/api/approvals/${approvalId}`) : null;
    check("P3 Keep paused rejects the folded approval", overrideAfter?.json?.status === "rejected" && overrideAfter.json.decidedByUserId === dotta.userId,
      `approval ${overrideAfter?.json?.status ?? "missing"} by ${name(overrideAfter?.json?.decidedByUserId)}`);
    const scottHandled = await history(scott, "handledForMe=true");
    const keptPaused = scottHandled.find((item) => item.sourceKind === "approval" && item.sourceId === approvalId);
    check("1d history: kept paused by Dotta for Scott", Boolean(approvalId) && keptPaused?.action?.outcome === "kept_paused"
      && keptPaused.resolvedByUserId === dotta.userId && keptPaused.handledForUserId === scott.userId,
    keptPaused ? `${keptPaused.action?.outcome} by ${name(keptPaused.resolvedByUserId)} for ${name(keptPaused.handledForUserId)}` : `not in Scott's Handled for me (${scottHandled.length} entries)`);
    // The same row in both people's own history (PAP-768 parts 2 and 3).
    const inOwnHistory = async (session: Session) => (await history(session, "scope=mine")).find((item) => item.sourceId === approvalId);
    const [scottOwn, dottaOwn, rileyOwn] = [await inOwnHistory(scott), await inOwnHistory(dotta), await inOwnHistory(riley)];
    check("P3 history: Kept paused by @Dotta · for @Scott in both histories", scottOwn?.action?.outcome === "kept_paused" && dottaOwn?.handledForUserId === scott.userId
      && !rileyOwn,
    `Scott ${scottOwn ? "yes" : "no"}, Dotta ${dottaOwn ? "yes" : "no"}, Riley ${rileyOwn ? "yes" : "no"}`);
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n[verify] ${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

await main();
