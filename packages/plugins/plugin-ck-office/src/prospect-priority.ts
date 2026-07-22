export interface EspoPage<T> {
  total: number;
  list: T[];
}

export async function paginateEspo<T>(
  fetchPage: (offset: number, maxSize: number) => Promise<EspoPage<T>>,
  pageSize = 200,
): Promise<{ list: T[]; sourceTotal: number; pagesScanned: number }> {
  const list: T[] = [];
  let sourceTotal = 0;
  let pagesScanned = 0;

  for (let offset = 0; ; offset += pageSize) {
    const page = await fetchPage(offset, pageSize);
    pagesScanned += 1;
    sourceTotal = Math.max(sourceTotal, Number(page.total) || 0);
    list.push(...(page.list || []));
    if (page.list.length < pageSize || list.length >= sourceTotal) break;
  }

  return { list, sourceTotal: Math.max(sourceTotal, list.length), pagesScanned };
}

export interface ProspectAccount {
  id: unknown;
  name?: unknown;
  emailAddress?: unknown;
  website?: unknown;
  cVertriebsstatus?: unknown;
  cPrioritaet?: unknown;
  cKategorie?: unknown;
  cChannel?: unknown;
  cAnsprechpartner?: unknown;
  billingAddressStreet?: unknown;
  billingAddressPostalCode?: unknown;
  billingAddressState?: unknown;
  billingAddressCity?: unknown;
  description?: unknown;
  type?: unknown;
}

export interface ProspectSuppression {
  sentAccountIds?: ReadonlySet<string>;
  inFlightAccountIds?: ReadonlySet<string>;
  activeIssueAccountIds?: ReadonlySet<string>;
  existingDraftAccountIds?: ReadonlySet<string>;
}

export interface RankedProspect {
  account_id: string;
  name: string;
  email: string;
  website: string;
  status: string;
  priority: string;
  category: string;
  channel: string;
  canton: string;
  city: string;
  street: string;
  postal_code: string;
  score: number;
  score_reasons: string[];
}

export interface SuppressedProspect {
  account_id: string;
  name: string;
  reason: string;
}

const EXPLICIT_DNC: Array<{ match: RegExp; reason: string }> = [
  { match: /suvretta/i, reason: "direct_client" },
  { match: /davidoff|davidoffgeneva/i, reason: "producer_or_brand_venue" },
  { match: /patoro/i, reason: "producer_or_brand_venue" },
  { match: /zigarren\s*d(ü|ue?)rr/i, reason: "producer_brand_retail" },
  { match: /la\s+casa\s+del\s+habano/i, reason: "producer_or_brand_venue" },
  { match: /\bavo\s+lounge\b/i, reason: "producer_or_brand_venue" },
];

function text(value: unknown): string {
  return String(value || "").trim();
}

function normalized(value: unknown): string {
  return text(value).toLocaleLowerCase("de-CH");
}

function searchable(value: unknown): string {
  return normalized(value)
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const NAME_STOP_WORDS = new Set([
  "hotel", "restaurant", "bar", "lounge", "cigar", "cigars", "zigarren",
  "tabak", "tabakwaren", "club", "shop", "gmbh", "ag", "sa", "sarl",
  "klg", "the", "and", "und",
]);

export interface ProspectIssue {
  title?: unknown;
  description?: unknown;
  status?: unknown;
  draftOwner?: boolean;
}

export function matchProspectIssueWork(
  accounts: ProspectAccount[],
  issues: ProspectIssue[],
): {
  activeIssueAccountIds: Set<string>;
  activeDraftAccountIds: Set<string>;
  activeLocalDraftAccountIds: Set<string>;
  activeExceptionalDraftAccountIds: Set<string>;
  existingDraftAccountIds: Set<string>;
} {
  const activeIssueAccountIds = new Set<string>();
  const activeDraftAccountIds = new Set<string>();
  const activeLocalDraftAccountIds = new Set<string>();
  const activeExceptionalDraftAccountIds = new Set<string>();
  const existingDraftAccountIds = new Set<string>();
  const activeStatuses = new Set(["backlog", "todo", "in_progress", "in_review"]);

  for (const issue of issues) {
    const status = normalized(issue.status);
    if (status === "cancelled") continue;
    const raw = `${text(issue.title)}\n${text(issue.description)}`;
    const haystack = searchable(raw);
    const isDraft = /\b(draft|outreach|erstansprache|first contact|first-contact)\b/i.test(raw);
    const exactAccountIds = new Set(
      accounts
        .map((account) => text(account.id))
        .filter((id) => id && raw.includes(id)),
    );

    for (const account of accounts) {
      const id = text(account.id);
      const accountName = searchable(account.name)
        .replace(/\b(gmbh|ag|sa|sarl|klg)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const significantTokens = accountName
        .split(" ")
        .filter((token) => token.length >= 4 && !NAME_STOP_WORDS.has(token));
      const matched = exactAccountIds.size > 0
        ? exactAccountIds.has(id)
        : (
          (accountName.length >= 6 && haystack.includes(accountName))
          || (
            significantTokens.length > 0
            && significantTokens.every((token) => haystack.includes(token))
          )
        );
      if (!matched) continue;
      if (activeStatuses.has(status)) activeIssueAccountIds.add(id);
      if (isDraft) {
        existingDraftAccountIds.add(id);
        if (activeStatuses.has(status) && issue.draftOwner !== false) {
          activeDraftAccountIds.add(id);
          if (/\[OUTREACH_LANE:exceptional\]/i.test(raw)) activeExceptionalDraftAccountIds.add(id);
          else activeLocalDraftAccountIds.add(id);
        }
      }
    }
  }

  return {
    activeIssueAccountIds,
    activeDraftAccountIds,
    activeLocalDraftAccountIds,
    activeExceptionalDraftAccountIds,
    existingDraftAccountIds,
  };
}

function scoreAccount(account: ProspectAccount): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(`${points >= 0 ? "+" : ""}${points} ${reason}`);
  };

  const priority = normalized(account.cPrioritaet);
  if (priority === "hoch") add(45, "CRM priority Hoch");
  else if (priority === "mittel") add(25, "CRM priority Mittel");
  else if (priority === "niedrig") add(10, "CRM priority Niedrig");

  const category = normalized(account.cKategorie);
  if (/lounge/.test(category)) add(25, "lounge placement fit");
  else if (/zigarr|cigar|tabak/.test(category)) add(22, "specialist cigar or tobacco channel");
  else if (/hotel/.test(category)) add(18, "hotel placement fit");
  else if (/restaurant|bar|spirituosen|wein/.test(category)) add(14, "hospitality placement fit");
  else if (/golf/.test(category)) add(8, "golf-club placement fit");

  const channel = normalized(account.cChannel);
  if (channel === "reseller") add(15, "CRM reseller channel");
  else if (channel === "hospitality") add(10, "CRM hospitality channel");

  if (text(account.emailAddress)) add(15, "CRM-verified email");
  if (text(account.website)) add(5, "website available for research");
  if (text(account.cAnsprechpartner)) add(5, "named CRM contact");
  if (text(account.billingAddressState)) add(3, "Swiss canton recorded");
  if (text(account.billingAddressCity)) add(2, "city recorded");

  return { score, reasons };
}

export function rankProspectAccounts(
  accounts: ProspectAccount[],
  suppression: ProspectSuppression,
): {
  ranked: RankedProspect[];
  suppressed: SuppressedProspect[];
  suppressedByReason: Record<string, number>;
} {
  const ranked: RankedProspect[] = [];
  const suppressed: SuppressedProspect[] = [];
  const suppressedByReason: Record<string, number> = {};

  const suppress = (account: ProspectAccount, reason: string) => {
    const row = {
      account_id: text(account.id),
      name: text(account.name) || "(unnamed)",
      reason,
    };
    suppressed.push(row);
    suppressedByReason[reason] = (suppressedByReason[reason] || 0) + 1;
  };

  for (const account of accounts) {
    const id = text(account.id);
    const name = text(account.name);
    const status = normalized(account.cVertriebsstatus);
    const target = `${name} ${text(account.website)} ${text(account.description)}`;
    const dnc = EXPLICIT_DNC.find((entry) => entry.match.test(target));

    if (!id || !name) suppress(account, "invalid_account");
    else if (status !== "noch offen") suppress(account, status ? `status:${status}` : "missing_sales_status");
    else if (dnc) suppress(account, `do_not_contact:${dnc.reason}`);
    else if (suppression.sentAccountIds?.has(id)) suppress(account, "already_contacted");
    else if (suppression.inFlightAccountIds?.has(id)) suppress(account, "pending_approval_or_opportunity");
    else if (suppression.activeIssueAccountIds?.has(id)) suppress(account, "active_paperclip_work");
    else if (suppression.existingDraftAccountIds?.has(id)) suppress(account, "existing_paperclip_draft");
    else if (!text(account.emailAddress)) suppress(account, "no_verified_email");
    else {
      const scored = scoreAccount(account);
      ranked.push({
        account_id: id,
        name,
        email: normalized(account.emailAddress),
        website: text(account.website),
        status: text(account.cVertriebsstatus),
        priority: text(account.cPrioritaet) || "Unspecified",
        category: text(account.cKategorie) || "Unspecified",
        channel: text(account.cChannel) || "Unspecified",
        canton: text(account.billingAddressState) || "Unspecified",
        city: text(account.billingAddressCity) || "Unspecified",
        street: text(account.billingAddressStreet),
        postal_code: text(account.billingAddressPostalCode),
        score: scored.score,
        score_reasons: scored.reasons,
      });
    }
  }

  ranked.sort(
    (a, b) =>
      b.score - a.score
      || a.name.localeCompare(b.name, "de-CH")
      || a.account_id.localeCompare(b.account_id),
  );
  suppressed.sort(
    (a, b) =>
      a.reason.localeCompare(b.reason)
      || a.name.localeCompare(b.name, "de-CH"),
  );
  return { ranked, suppressed, suppressedByReason };
}
