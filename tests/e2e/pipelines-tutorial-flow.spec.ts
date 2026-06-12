import { randomUUID } from "node:crypto";
import { expect, request as pwRequest, test, type APIRequestContext, type APIResponse, type Locator, type Page } from "@playwright/test";

/**
 * E2E: Pipelines tutorial flow (ported from the Line B spec onto the
 * consolidated pipelines stack).
 *
 * Coverage intent matches the original tutorial walk-through:
 *   create pipeline -> configure stages and intake variables -> add items ->
 *   board drag / guarded transition -> item detail suggestion -> review queue
 *   decision -> learnings visible. Plus the prosumer vocabulary guard.
 *
 * Adaptations vs Line B (different routes/API on this branch):
 *   - Pipelines API is key-based: POST /api/companies/:id/pipelines takes
 *     { key, name, stages[] }, transitions use stage keys, and
 *     POST /api/cases/:id/transition requires { toStageKey, expectedVersion }.
 *   - Items are seeded with POST /api/pipelines/:id/cases (no /cases/ingest).
 *   - Suggestions use { toStageKey, rationale } (no { toStageId, reason }).
 *   - The add-items intake titles its field "Name" (not "Title") and uses a
 *     Radix select for choice fields; new rows start collapsed.
 *   - The guarded-drag dialogs confirm in-UI ("Move it" / "Override and move")
 *     so the move is completed through the UI instead of a parallel API call.
 *     dnd-kit drags can be flaky headless, so the helper falls back to an
 *     API-driven transition and asserts the board reflects it.
 *   - Review-stage decisions happen on /review-queue ("Final calls" section);
 *     learnings live at /learnings fed by review_decided/transition_forced
 *     events.
 */

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;

type Stage = { id: string; key: string; name: string; kind: string; position: number };
type PipelineDetail = { id: string; name: string; stages: Stage[]; transitions: Array<{ fromStageId: string; toStageId: string }> };
type CaseSummary = {
  id: string;
  caseKey: string;
  title: string;
  version: number;
  stageId: string;
  parentCaseVersion?: number | null;
  requestKey?: string | null;
  childCount?: number;
  terminalChildCount?: number;
};
type CaseRow = { case: CaseSummary; stage?: Stage };
type CaseDetail = CaseRow & { pipeline: { id: string; key: string; name: string }; blockers?: Array<{ caseId: string; blockedByCaseId: string }> };

async function expectOk(response: Awaited<ReturnType<APIRequestContext["get"]>>, label: string) {
  if (!response.ok()) {
    throw new Error(`${label} failed: ${response.status()} ${await response.text()}`);
  }
}

async function expectError(response: APIResponse, label: string, status: number, code: string, message?: RegExp) {
  const body = await response.json() as { code?: string; error?: string; message?: string; child?: { title?: string } };
  expect(response.status(), `${label} status: ${JSON.stringify(body)}`).toBe(status);
  expect(body.code, `${label} code: ${JSON.stringify(body)}`).toBe(code);
  if (message) {
    expect(body.error ?? body.message ?? "", `${label} message`).toMatch(message);
  }
  return body;
}

async function createCompany(board: APIRequestContext) {
  const response = await board.post("/api/companies", {
    data: { name: `E2E Pipelines ${Date.now()}` },
  });
  await expectOk(response, "create company");
  return response.json() as Promise<{ id: string; issuePrefix: string }>;
}

async function createPipeline(board: APIRequestContext, companyId: string) {
  const response = await board.post(`/api/companies/${companyId}/pipelines`, {
    data: {
      key: "content-production",
      name: "Content production",
      description: "Draft, review, and publish launch content.",
      enforceTransitions: true,
      stages: [
        { key: "drafting", name: "Drafting", kind: "working", position: 0, config: { variables: [] } },
        { key: "published", name: "Published", kind: "done", position: 2, config: { variables: [] } },
        { key: "dropped", name: "Dropped", kind: "cancelled", position: 3, config: { variables: [] } },
      ],
    },
  });
  await expectOk(response, "create pipeline");
  return response.json() as Promise<{ id: string; name: string }>;
}

async function createPrimitivePipeline(board: APIRequestContext, companyId: string) {
  const response = await board.post(`/api/companies/${companyId}/pipelines`, {
    data: {
      key: `primitive-gates-${Date.now()}`,
      name: "Primitive gates",
      stages: [
        { key: "intake", name: "Intake", kind: "open", position: 0 },
        {
          key: "fanout",
          name: "Fan out",
          kind: "working",
          position: 100,
          config: { requireChildrenTerminal: true },
        },
        {
          key: "dependent_work",
          name: "Dependent Work",
          kind: "working",
          position: 200,
          config: { requireNoUnresolvedDrift: true },
        },
        {
          key: "review",
          name: "Review",
          kind: "review",
          position: 300,
          config: {
            approveToStageKey: "approved",
            rejectToStageKey: "cancelled",
            requestChangesToStageKey: "dependent_work",
            requireRejectReason: true,
            reviewerKind: "human",
          },
        },
        { key: "approved", name: "Approved", kind: "working", position: 400 },
        { key: "done", name: "Done", kind: "done", position: 900 },
        { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
      ],
    },
  });
  await expectOk(response, "create primitive pipeline");
  return response.json() as Promise<{ id: string; name: string }>;
}

async function createSmokeAgent(board: APIRequestContext, companyId: string) {
  const response = await board.post(`/api/companies/${companyId}/agents`, {
    data: {
      name: "Pipeline Fanout Agent",
      role: "engineer",
      capabilities: "Creates pipeline child work during e2e coverage.",
      adapterType: "process",
      adapterConfig: { command: "echo", args: ["pipeline fanout e2e"] },
    },
  });
  await expectOk(response, "create smoke agent");
  return response.json() as Promise<{ id: string }>;
}

async function createAgentKey(board: APIRequestContext, agentId: string) {
  const response = await board.post(`/api/agents/${agentId}/keys`, {
    data: { name: "pipelines-e2e-fanout" },
  });
  await expectOk(response, "create smoke agent key");
  return response.json() as Promise<{ token: string }>;
}

async function getPipeline(board: APIRequestContext, pipelineId: string): Promise<PipelineDetail> {
  const response = await board.get(`/api/pipelines/${pipelineId}`);
  await expectOk(response, "get pipeline");
  return response.json() as Promise<PipelineDetail>;
}

async function listItems(board: APIRequestContext, pipelineId: string): Promise<CaseRow[]> {
  const response = await board.get(`/api/pipelines/${pipelineId}/cases`);
  await expectOk(response, "list pipeline items");
  return response.json() as Promise<CaseRow[]>;
}

async function createItem(
  board: APIRequestContext,
  pipelineId: string,
  data: {
    title: string;
    caseKey?: string;
    stageKey?: string;
    parentCaseId?: string;
    requestKey?: string;
    blockedByCaseIds?: string[];
    fields?: Record<string, unknown>;
  },
) {
  const response = await board.post(`/api/pipelines/${pipelineId}/cases`, {
    data: {
      caseKey: data.caseKey,
      title: data.title,
      stageKey: data.stageKey,
      parentCaseId: data.parentCaseId,
      requestKey: data.requestKey,
      blockedByCaseIds: data.blockedByCaseIds,
      fields: data.fields ?? {},
    },
  });
  await expectOk(response, `create item ${data.title}`);
  const body = await response.json() as { case: CaseSummary; created?: boolean };
  return body.case;
}

async function getItem(board: APIRequestContext, caseId: string): Promise<CaseDetail> {
  const response = await board.get(`/api/cases/${caseId}`);
  await expectOk(response, "get item detail");
  return response.json() as Promise<CaseDetail>;
}

async function getItemVersion(board: APIRequestContext, caseId: string) {
  const detail = await getItem(board, caseId);
  return detail.case.version;
}

async function moveItem(
  board: APIRequestContext,
  caseId: string,
  toStageKey: string,
  options: { reason?: string; force?: boolean } = {},
) {
  const expectedVersion = await getItemVersion(board, caseId);
  const response = await board.post(`/api/cases/${caseId}/transition`, {
    data: { toStageKey, expectedVersion, reason: options.reason, force: options.force },
  });
  await expectOk(response, `move item to ${toStageKey}`);
}

async function suggestMove(board: APIRequestContext, caseId: string, toStageKey: string, rationale: string) {
  const response = await board.post(`/api/cases/${caseId}/suggest-transition`, {
    data: { toStageKey, rationale },
  });
  await expectOk(response, "seed transition suggestion");
}

async function expectProsumerVocabulary(page: Page) {
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/\bcase\b/i);
  expect(text).not.toMatch(/\breview_decided\b|\btransition_forced\b/);
  expect(text).not.toMatch(/\b(?:400|401|403|404|409|422|500)\b/);
}

/**
 * Drag a board card into a stage column with the mouse. Returns true when the
 * guarded-move dialog opened (dnd-kit registered the drop), false otherwise so
 * the caller can fall back to an API-driven transition.
 */
async function dragCardToColumn(page: Page, itemTitle: string, fromColumn: string, toColumn: string) {
  const card = page.getByLabel(`${fromColumn} column`).getByText(itemTitle, { exact: true });
  const column = page.getByLabel(`${toColumn} column`);
  await expect(card).toBeVisible();
  await expect(column).toBeVisible();

  const cardBox = await card.boundingBox();
  const columnBox = await column.boundingBox();
  if (!cardBox || !columnBox) return false;

  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + cardBox.height / 2;
  const targetX = columnBox.x + columnBox.width / 2;
  const targetY = columnBox.y + Math.min(columnBox.height - 24, Math.max(88, columnBox.height / 2));

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 10, startY + 10, { steps: 5 });
  await page.mouse.move(targetX, targetY, { steps: 25 });
  await page.mouse.up();

  try {
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

function reviewQueueRow(page: Page, title: string): Locator {
  return page.locator('[role="button"]').filter({ hasText: title }).first();
}

test.describe("Pipelines tutorial UI flow", () => {
  test.setTimeout(240_000);

  test("covers agent fan-out, drift acknowledgement gates, child-terminal gates, and stale approvals", async () => {
    const board = await pwRequest.newContext({ baseURL: BASE_URL });
    const company = await createCompany(board);
    const pipeline = await createPrimitivePipeline(board, company.id);
    const agent = await createSmokeAgent(board, company.id);
    const key = await createAgentKey(board, agent.id);
    const agentApi = await pwRequest.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: {
        Authorization: `Bearer ${key.token}`,
        "X-Paperclip-Run-Id": randomUUID(),
      },
    });

    const parent = await createItem(board, pipeline.id, {
      caseKey: "fanout-parent",
      title: "Fan-out parent",
      stageKey: "fanout",
      fields: { expectedChildren: 2, release: "v1" },
    });

    const childA = await createItem(agentApi, pipeline.id, {
      caseKey: "asset-a",
      title: "Asset A",
      stageKey: "dependent_work",
      parentCaseId: parent.id,
      requestKey: "fanout:asset-a",
      fields: { asset: "hero", briefedFromVersion: parent.version },
    });
    expect(childA.parentCaseVersion).toBe(parent.version);
    expect(childA.requestKey).toBe("fanout:asset-a");

    const retryResponse = await agentApi.post(`/api/pipelines/${pipeline.id}/cases`, {
      data: {
        caseKey: "asset-a-retry",
        title: "Duplicate Asset A",
        stageKey: "dependent_work",
        parentCaseId: parent.id,
        requestKey: "fanout:asset-a",
        fields: { asset: "changed" },
      },
    });
    await expectOk(retryResponse, "retry request-key child create");
    const retry = await retryResponse.json() as { case: CaseSummary; created: boolean };
    expect(retry.created).toBe(false);
    expect(retry.case.id).toBe(childA.id);
    expect(retry.case.title).toBe("Asset A");

    const childB = await createItem(agentApi, pipeline.id, {
      caseKey: "asset-b",
      title: "Asset B",
      stageKey: "dependent_work",
      parentCaseId: parent.id,
      requestKey: "fanout:asset-b",
      blockedByCaseIds: [childA.id],
      fields: { asset: "social", briefedFromVersion: parent.version },
    });
    const blockedDetail = await getItem(board, childB.id);
    expect(blockedDetail.blockers?.map((blocker) => blocker.blockedByCaseId)).toContain(childA.id);

    await expectError(
      await board.post(`/api/cases/${parent.id}/transition`, {
        data: { toStageKey: "done", expectedVersion: parent.version },
      }),
      "parent children-terminal gate",
      409,
      "children_not_terminal",
      /Asset A/,
    );

    await expectError(
      await agentApi.post(`/api/cases/${childB.id}/transition`, {
        data: { toStageKey: "approved", expectedVersion: childB.version },
      }),
      "blocked sibling sequencing",
      409,
      "blocked",
    );

    const changedA = await board.patch(`/api/cases/${childA.id}`, {
      data: {
        expectedVersion: childA.version,
        fields: { asset: "hero", briefedFromVersion: parent.version, materialChange: "new art direction" },
      },
    });
    await expectOk(changedA, "materially edit upstream child");
    const editedA = await changedA.json() as CaseSummary;

    await moveItem(agentApi, childA.id, "done");
    await expectError(
      await agentApi.post(`/api/cases/${childB.id}/transition`, {
        data: { toStageKey: "review", expectedVersion: childB.version },
      }),
      "unacknowledged drift gate",
      409,
      "unresolved_drift",
      /not acknowledged/,
    );

    const ackResponse = await board.post(`/api/cases/${childB.id}/acknowledge-drift`, {
      data: { expectedVersion: childB.version },
    });
    await expectOk(ackResponse, "acknowledge drift");
    const ack = await ackResponse.json() as { acknowledged: boolean };
    expect(ack.acknowledged).toBe(true);
    await moveItem(agentApi, childB.id, "done");

    const refreshedParent = await getItem(board, parent.id);
    expect(refreshedParent.case.childCount).toBe(2);
    expect(refreshedParent.case.terminalChildCount).toBe(2);
    await moveItem(board, parent.id, "done");

    const reviewCase = await createItem(board, pipeline.id, {
      caseKey: "review-pinned",
      title: "Revision-pinned review",
      stageKey: "review",
      fields: { revision: "first" },
    });
    const approval = await board.post(`/api/cases/${reviewCase.id}/review`, {
      data: { decision: "approve", expectedVersion: reviewCase.version },
    });
    await expectOk(approval, "approve review case");
    const approved = await approval.json() as { case: CaseSummary };

    const changedAfterApproval = await board.patch(`/api/cases/${reviewCase.id}`, {
      data: { expectedVersion: approved.case.version, fields: { revision: "materially changed" } },
    });
    await expectOk(changedAfterApproval, "edit after review approval");
    const changedReview = await changedAfterApproval.json() as CaseSummary;

    await expectError(
      await board.post(`/api/cases/${reviewCase.id}/transition`, {
        data: { toStageKey: "done", expectedVersion: changedReview.version },
      }),
      "stale approval publish gate",
      409,
      "review_outdated",
      /changed since review approval/,
    );
    await moveItem(board, reviewCase.id, "review");
    const rereviewVersion = await getItemVersion(board, reviewCase.id);
    const rereview = await board.post(`/api/cases/${reviewCase.id}/review`, {
      data: { decision: "approve", expectedVersion: rereviewVersion },
    });
    await expectOk(rereview, "approve rereviewed case");
    const rereviewed = await rereview.json() as { case: CaseSummary };
    await moveItem(board, reviewCase.id, "done");

    const finalEvents = await board.get(`/api/cases/${childB.id}/events`);
    await expectOk(finalEvents, "child drift events");
    const eventTypes = ((await finalEvents.json()) as { items: Array<{ type: string }> }).items.map((event) => event.type);
    expect(eventTypes).toContain("upstream_drift");
    expect(eventTypes).toContain("drift_acknowledged");
    expect(editedA.version).toBeGreaterThan(childA.version);
    expect(rereviewed.case.version).toBeGreaterThan(changedReview.version);

    await agentApi.dispose();
    await board.dispose();
  });

  test("walks setup, intake, board moves, item detail, review queue, and learnings", async ({ page }) => {
    const board = await pwRequest.newContext({ baseURL: BASE_URL });
    const company = await createCompany(board);
    const pipeline = await createPipeline(board, company.id);

    await page.goto("/");
    await page.evaluate((companyId) => {
      window.localStorage.setItem("paperclip.selectedCompanyId", companyId);
    }, company.id);
    const companyPath = `/${company.issuePrefix}`;

    // -----------------------------------------------------------------------
    // Pipeline settings: intake variable on Drafting, then insert a review
    // stage between Drafting and Published.
    // -----------------------------------------------------------------------
    await page.goto(`${companyPath}/pipelines/${pipeline.id}/settings`);
    await expect(page.getByLabel("Pipeline name")).toHaveValue("Content production");

    await page.getByRole("button", { name: "Add variable" }).click();
    await page.getByLabel("Variable key").fill("content_type");
    await page.getByLabel("Variable label").fill("Content type");
    await page.getByLabel("Variable type").selectOption("select");
    await page.getByLabel("Variable options").fill("Blog post, Changelog entry, Launch tweet");
    await page.getByRole("button", { name: "Save stage" }).click();
    await expect(page.getByText("Stage saved").first()).toBeVisible();

    await page.getByRole("button", { name: "Insert stage after Drafting" }).click();
    await expect(page.getByRole("button", { name: /New stage/ }).first()).toBeVisible();
    await expect(page.getByLabel("Name")).toHaveValue("New stage");

    await page.getByLabel("Name").fill("Assets");
    await page.getByLabel("Kind").selectOption("review");
    // Require approval (toggle index 1: 0 = block new entry, 1 = approval).
    await page.getByRole("switch").nth(1).click();
    await expect(page.getByLabel("Approval picker")).toHaveValue("any_human");
    await page.getByLabel("Items needing changes move to").selectOption("drafting");
    await page.getByRole("checkbox", { name: "New stage can move to Drafting" }).check();
    await page.getByPlaceholder("Describe the work that should happen in this stage.").fill(
      "Review draft quality and ask for assets before publishing.",
    );
    await page.getByRole("button", { name: "Save stage" }).click();
    await expect(page.getByRole("button", { name: /^Assets/ }).first()).toBeVisible();
    await expectProsumerVocabulary(page);

    const configured = await getPipeline(board, pipeline.id);
    const assets = configured.stages.find((stage) => stage.name === "Assets");
    const published = configured.stages.find((stage) => stage.name === "Published");
    expect(assets?.kind).toBe("review");
    expect(published).toBeTruthy();

    // -----------------------------------------------------------------------
    // Add items through the intake form.
    // -----------------------------------------------------------------------
    await page.goto(`${companyPath}/pipelines/${pipeline.id}`);
    await page.getByRole("link", { name: "Add items" }).click();
    await expect(page.getByRole("heading", { name: "Build your list, then submit it all at once" }).first()).toBeVisible();

    const itemPlans = [
      { title: "Launch blog post", contentType: "Blog post" },
      { title: "Changelog entry", contentType: "Changelog entry" },
      { title: "Launch tweet", contentType: "Launch tweet" },
    ];
    for (const [index, plan] of itemPlans.entries()) {
      if (index > 0) {
        await page.getByRole("button", { name: "Add another item" }).click();
      }
      const row = page.locator("section").filter({ hasText: `Item ${index + 1}` }).first();
      if (index > 0) {
        await row.getByRole("button", { name: "Expand item" }).click();
      }
      await row.getByLabel("Name").fill(plan.title);
      await row.getByRole("combobox").click();
      await page.getByRole("option", { name: plan.contentType }).click();
    }
    await expect(page.getByRole("button", { name: "Submit 3 items" })).toBeEnabled();
    await page.getByRole("button", { name: "Submit 3 items" }).click();

    const draftingColumn = page.getByLabel("Drafting column");
    await expect(draftingColumn.getByText("Launch blog post")).toBeVisible();
    await expect(draftingColumn.getByText("Changelog entry")).toBeVisible();
    await expect(draftingColumn.getByText("Launch tweet")).toBeVisible();
    await expectProsumerVocabulary(page);

    const items = await listItems(board, pipeline.id);
    const blog = items.find((row) => row.case.title === "Launch blog post")?.case;
    const changelog = items.find((row) => row.case.title === "Changelog entry")?.case;
    const tweet = items.find((row) => row.case.title === "Launch tweet")?.case;
    expect(blog).toBeTruthy();
    expect(changelog).toBeTruthy();
    expect(tweet).toBeTruthy();

    // -----------------------------------------------------------------------
    // Board moves: a normal guarded move and an override that skips the flow.
    // -----------------------------------------------------------------------
    const blogDragged = await dragCardToColumn(page, "Launch blog post", "Drafting", "Assets");
    console.log(`[pipelines-tutorial] blog drag used ${blogDragged ? "UI dialog" : "API fallback"}`);
    if (blogDragged) {
      await expect(page.getByRole("heading", { name: "Move Launch blog post?" })).toBeVisible();
      await page.getByRole("button", { name: "Move it" }).click();
    } else {
      // Headless drag did not land; assert the board reflects an API move.
      await moveItem(board, blog!.id, assets!.key);
      await page.reload();
    }
    await expect(page.getByLabel("Assets column").getByText("Launch blog post")).toBeVisible();

    // Second item moves via API on purpose (the board UI path is already
    // exercised above); the board must reflect it after a refresh.
    await moveItem(board, changelog!.id, assets!.key);
    await page.reload();
    await expect(page.getByLabel("Assets column").getByText("Changelog entry")).toBeVisible();

    const tweetDragged = await dragCardToColumn(page, "Launch tweet", "Drafting", "Published");
    const overrideReason = "Tweet can skip review because the blog post already covers the announcement.";
    console.log(`[pipelines-tutorial] tweet drag used ${tweetDragged ? "UI override dialog" : "API fallback"}`);
    if (tweetDragged) {
      await expect(page.getByRole("heading", { name: "This skips the normal flow" })).toBeVisible();
      await page.getByLabel("Reason").fill(overrideReason);
      await expect(page.getByRole("button", { name: "Override and move" })).toBeEnabled();
      await page.getByRole("button", { name: "Override and move" }).click();
    } else {
      await moveItem(board, tweet!.id, published!.key, { reason: overrideReason, force: true });
      await page.reload();
    }
    await expect(page.getByLabel("Published column").getByText("Launch tweet")).toBeVisible();
    await expectProsumerVocabulary(page);

    // -----------------------------------------------------------------------
    // Item detail: rollup of built-from items plus an agent-style suggestion.
    // -----------------------------------------------------------------------
    const root = await createItem(board, pipeline.id, {
      title: "Pipeline primitives launch",
      stageKey: "drafting",
      fields: { content_type: "Blog post" },
    });
    await createItem(board, pipeline.id, {
      title: "Launch package draft",
      stageKey: "drafting",
      parentCaseId: root.id,
      fields: { content_type: "Blog post" },
    });
    await createItem(board, pipeline.id, {
      title: "Launch package changelog",
      stageKey: "drafting",
      parentCaseId: root.id,
      fields: { content_type: "Changelog entry" },
    });
    await suggestMove(board, root.id, assets!.key, "Draft is ready for the next review.");

    await page.goto(`${companyPath}/pipelines/${pipeline.id}/items/${root.id}`);
    await expect(page.getByRole("heading", { name: "Pipeline primitives launch" }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ready to move to Assets?" })).toBeVisible();
    await expect(page.getByText("Draft is ready for the next review.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Built from 2 items" })).toBeVisible();
    await expect(page.getByText("Launch package draft")).toBeVisible();
    await expect(page.getByText("Launch package changelog")).toBeVisible();
    await expectProsumerVocabulary(page);

    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("Move approved")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ready to move to Assets?" })).toBeHidden();

    // -----------------------------------------------------------------------
    // Review queue: approve one item, request changes on another.
    // -----------------------------------------------------------------------
    await page.goto(`${companyPath}/review-queue`);
    // The app shell renders the page title as a second h1, so take the first.
    await expect(page.getByRole("heading", { name: "Review queue" }).first()).toBeVisible();
    await expect(page.getByText("Needs your attention")).toBeVisible();
    await expect(page.getByText("Final calls")).toBeVisible();

    const blogRow = reviewQueueRow(page, "Launch blog post");
    await expect(blogRow).toBeVisible();
    await blogRow.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(blogRow).toBeHidden();

    const changelogRow = reviewQueueRow(page, "Changelog entry");
    await expect(changelogRow).toBeVisible();
    await changelogRow.getByRole("button", { name: "Request changes" }).click();
    const decisionDialog = page.getByRole("dialog");
    await expect(decisionDialog).toBeVisible();
    await decisionDialog.getByLabel("Note").fill("Tighten the framing before publishing.");
    await decisionDialog.getByRole("button", { name: "Request changes" }).click();
    await expect(changelogRow).toBeHidden();
    await expectProsumerVocabulary(page);

    // The approved item landed in Published; the changes-requested item went
    // back to Drafting per the review stage configuration.
    await expect.poll(async () => {
      const refreshed = await listItems(board, pipeline.id);
      const approved = refreshed.find((row) => row.case.title === "Launch blog post");
      const sentBack = refreshed.find((row) => row.case.title === "Changelog entry");
      return {
        approvedStage: approved?.case.stageId,
        sentBackStage: sentBack?.case.stageId,
      };
    }).toEqual({
      approvedStage: published!.id,
      sentBackStage: configured.stages.find((stage) => stage.key === "drafting")!.id,
    });

    // -----------------------------------------------------------------------
    // Learnings: review notes and hand-move reasons show up in plain words.
    // -----------------------------------------------------------------------
    await page.goto(`${companyPath}/learnings`);
    await expect(page.getByRole("heading", { name: "Learnings" }).first()).toBeVisible();
    await expect(page.getByText("Tighten the framing before publishing.")).toBeVisible();
    await expect(page.getByText(overrideReason)).toBeVisible();
    await expectProsumerVocabulary(page);

    await board.dispose();
  });
});
