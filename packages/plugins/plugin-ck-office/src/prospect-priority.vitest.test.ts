import assert from "node:assert/strict";
import { test } from "vitest";
import {
  paginateEspo,
  matchProspectIssueWork,
  rankProspectAccounts,
  type ProspectAccount,
} from "./prospect-priority.js";

test("paginateEspo scans the complete universe beyond Espo's 200-row cap", async () => {
  const rows = Array.from({ length: 509 }, (_, index) => ({ id: String(index) }));
  const offsets: number[] = [];
  const result = await paginateEspo(async (offset, maxSize) => {
    offsets.push(offset);
    return { total: rows.length, list: rows.slice(offset, offset + maxSize) };
  });

  assert.equal(result.list.length, 509);
  assert.equal(result.sourceTotal, 509);
  assert.equal(result.pagesScanned, 3);
  assert.deepEqual(offsets, [0, 200, 400]);
});

test("ranking suppresses prior contact, in-flight work, DNC, and unreachable accounts", () => {
  const base = {
    cVertriebsstatus: "Noch offen",
    cPrioritaet: "Hoch",
    cKategorie: "Hotel / Lounge",
    cChannel: "Hospitality",
    billingAddressState: "BE",
    billingAddressCity: "Bern",
  };
  const accounts: ProspectAccount[] = [
    { ...base, id: "ready", name: "Ready Hotel", emailAddress: "info@ready.ch", website: "https://ready.ch" },
    { ...base, id: "sent", name: "Sent Hotel", emailAddress: "info@sent.ch" },
    { ...base, id: "pending", name: "Pending Hotel", emailAddress: "info@pending.ch" },
    { ...base, id: "task", name: "Task Hotel", emailAddress: "info@task.ch" },
    { ...base, id: "draft", name: "Existing Draft Hotel", emailAddress: "info@draft.ch" },
    { ...base, id: "no-email", name: "No Email Hotel" },
    { ...base, id: "dnc", name: "Davidoff Smoker Lounge", emailAddress: "info@dnc.ch" },
    { ...base, id: "lost", name: "Lost Hotel", emailAddress: "info@lost.ch", cVertriebsstatus: "Kein Interesse" },
  ];

  const result = rankProspectAccounts(accounts, {
    sentAccountIds: new Set(["sent"]),
    inFlightAccountIds: new Set(["pending"]),
    activeIssueAccountIds: new Set(["task"]),
    existingDraftAccountIds: new Set(["draft"]),
  });

  assert.deepEqual(result.ranked.map((row) => row.account_id), ["ready"]);
  assert.equal(result.suppressedByReason.already_contacted, 1);
  assert.equal(result.suppressedByReason.pending_approval_or_opportunity, 1);
  assert.equal(result.suppressedByReason.active_paperclip_work, 1);
  assert.equal(result.suppressedByReason.existing_paperclip_draft, 1);
  assert.equal(result.suppressedByReason.no_verified_email, 1);
  assert.equal(result.suppressedByReason["do_not_contact:producer_or_brand_venue"], 1);
  assert.equal(result.suppressedByReason["status:kein interesse"], 1);
});

test("historical draft matching catches legacy title-only work without account ids", () => {
  const accounts: ProspectAccount[] = [
    { id: "maduro", name: "Maduro GmbH Olten" },
    { id: "wellauer", name: "Wellauer AG" },
    { id: "other", name: "Unrelated Hotel" },
  ];
  const result = matchProspectIssueWork(accounts, [
    {
      status: "done",
      title: "Draft: MADURO GmbH Olten — Tres Hermanos Erstansprache",
    },
    {
      status: "done",
      title: "Draft first-contact email: Tabacaria Wellauer — Olten",
    },
  ]);

  assert.deepEqual(
    [...result.existingDraftAccountIds].sort(),
    ["maduro", "wellauer"],
  );
  assert.equal(result.activeIssueAccountIds.size, 0);
  assert.equal(result.activeDraftAccountIds.size, 0);
});

test("active draft work reserves local and exceptional queue lanes", () => {
  const accounts: ProspectAccount[] = [
    { id: "local", name: "Local Lounge" },
    { id: "wildcard", name: "Exceptional Hotel" },
  ];
  const result = matchProspectIssueWork(accounts, [
    {
      status: "in_review",
      title: "Draft outreach: Local Lounge",
      description: "[OUTREACH_LANE:local]\nAccount ID: local",
    },
    {
      status: "todo",
      title: "Draft outreach: Exceptional Hotel",
      description: "[OUTREACH_LANE:exceptional]\nAccount ID: wildcard",
    },
  ]);

  assert.deepEqual([...result.activeLocalDraftAccountIds], ["local"]);
  assert.deepEqual([...result.activeExceptionalDraftAccountIds], ["wildcard"]);
  assert.equal(result.activeDraftAccountIds.size, 2);
});

test("research tasks that mention drafting suppress duplicates but do not consume draft capacity", () => {
  const accounts: ProspectAccount[] = [
    { id: "research", name: "Research Hotel" },
  ];
  const result = matchProspectIssueWork(accounts, [
    {
      status: "todo",
      title: "Research Research Hotel before outreach draft",
      description: "Account ID: research",
      draftOwner: false,
    },
  ]);

  assert.deepEqual([...result.existingDraftAccountIds], ["research"]);
  assert.equal(result.activeIssueAccountIds.size, 1);
  assert.equal(result.activeDraftAccountIds.size, 0);
});

test("an explicit account id prevents one dossier from fuzzy-matching other accounts", () => {
  const accounts: ProspectAccount[] = [
    { id: "exact", name: "Grand Resort Bad Ragaz" },
    { id: "other", name: "Grand Resort Bern" },
  ];
  const result = matchProspectIssueWork(accounts, [
    {
      status: "backlog",
      title: "Draft outreach: Grand Resort Bad Ragaz",
      description: "Account ID: exact\nComparison context: Grand Resort Bern",
      draftOwner: true,
    },
  ]);

  assert.deepEqual([...result.activeDraftAccountIds], ["exact"]);
});

test("ranking is deterministic and gives CRM priority more weight than weak fit", () => {
  const result = rankProspectAccounts(
    [
      {
        id: "medium",
        name: "Medium Cigar Lounge",
        emailAddress: "info@medium.ch",
        cVertriebsstatus: "Noch offen",
        cPrioritaet: "Mittel",
        cKategorie: "Lounge",
      },
      {
        id: "high",
        name: "High Golf Club",
        emailAddress: "info@high.ch",
        cVertriebsstatus: "Noch offen",
        cPrioritaet: "Hoch",
        cKategorie: "Golf Club",
      },
    ],
    {},
  );

  assert.deepEqual(result.ranked.map((row) => row.account_id), ["high", "medium"]);
  assert.ok(result.ranked[0].score_reasons.includes("+45 CRM priority Hoch"));
});
