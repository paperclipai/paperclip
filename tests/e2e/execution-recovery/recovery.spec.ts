import { test, expect } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { listenOnFetchAllowedPort } from "../fetch-allowed-port";

// Each attempt starts the source CLI's test-drive without --data-dir. The model
// and MCP provider are deterministic fixtures; authorization/cards/wakes are real.
for (const journey of [
  "safe",
  "uncertain",
  "safe_restart",
  "ceo_lineage",
  "legacy_unknown",
] as const)
  test(`fresh execution recovery and current-request journey: ${journey}`, async ({
    page,
  }, info) => {
    const root = resolve(import.meta.dirname, "../../..");
    let processHandle: ChildProcess | undefined;
    let logs = "";
    let diagnosticState = async () => ({});
    async function stopDrive() {
      if (processHandle?.pid) {
        const child = processHandle;
        const stopped = new Promise<void>((done) =>
          child.once("exit", () => done()),
        );
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {}
        if (child.exitCode === null && child.signalCode === null) {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            stopped,
            new Promise<void>((done) => {
              timeout = setTimeout(() => {
                try {
                  process.kill(-child.pid!, "SIGKILL");
                } catch {}
                done();
              }, 15_000);
            }),
          ]);
          clearTimeout(timeout);
        }
      }
    }

    const calls: string[] = [];
    let gmailReadCount = 0;
    const fixture = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const part of req) chunks.push(Buffer.from(part));
      const message = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const gmail = req.url === "/gmail";
      calls.push(`${gmail ? "gmail" : "notion"}:${message.method}`);
      if (message.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: {
                name: gmail ? "gmail-fixture" : "heliotrope",
                version: "1",
              },
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  {
                    name: gmail ? "gmail_read" : "archive_read",
                    description: gmail
                      ? "Read gmail-fixture launch email decisions"
                      : "Read heliotrope launch decisions",
                    annotations: { readOnlyHint: true, destructiveHint: false },
                    inputSchema: {
                      type: "object",
                      properties: {},
                      additionalProperties: false,
                    },
                  },
                ],
              }
            : message.method === "tools/call"
              ? {
                  content: [
                    {
                      type: "text",
                      text: gmail
                        ? ++gmailReadCount === 1 && journey !== "ceo_lineage"
                          ? journey !== "uncertain"
                            ? "RECOVERY-INJECT-SAFE"
                            : "RECOVERY-INJECT-UNKNOWN-WRITE"
                          : "GMAIL-73: The launch email confirms Friday approval. Source: https://example.invalid/mail/gmail-73"
                        : "HELIOTROPE-42: Launch in two stages; support handoff belongs to Mira. Source: https://example.invalid/launch/heliotrope-42",
                    },
                  ],
                }
              : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    try {
      const port = await listenOnFetchAllowedPort(fixture);
      const env = {
        ...process.env,
        PAPERCLIP_RECOVERY_CEO_LINEAGE: journey === "ceo_lineage" ? "1" : "0",
        IN_FEED_FIXTURE_KEY: "not-a-real-model-key",
        NODE_ENV: "test",
        PATH: `${root}/tests/e2e/fixtures/recovery-bin:${process.env.PATH}`,
      };
      delete env.DATABASE_URL;
      delete env.DATABASE_MIGRATION_URL;
      processHandle = spawn(
        process.execPath,
        [
          "cli/node_modules/tsx/dist/cli.mjs",
          "cli/src/index.ts",
          "test-drive",
          "--harness",
          "codex",
          "--api-key-env",
          "IN_FEED_FIXTURE_KEY",
          "--company-name",
          "Execution recovery fixture",
          "--no-browser",
        ],
        { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      processHandle.stdout!.on("data", (chunk) => {
        logs += chunk.toString();
      });
      processHandle.stderr!.on("data", (chunk) => {
        logs += chunk.toString();
      });
      await expect
        .poll(
          () =>
            logs.match(
              /Paperclip is ready at (http:\/\/127\.0\.0\.1:\d+)/,
            )?.[1],
          { timeout: 100_000 },
        )
        .toBeTruthy();
      let base = logs.match(
        /Paperclip is ready at (http:\/\/127\.0\.0\.1:\d+)/,
      )![1]!;
      const api = async (path: string, method = "GET", data?: unknown) => {
        const response = await page.request.fetch(`${base}/api${path}`, {
          method,
          data,
        });
        expect(response.ok(), await response.text()).toBeTruthy();
        return response.json();
      };
      const isSettledRun = (run: { status: string; errorCode?: string }) =>
        run.status === "succeeded" ||
        (run.status === "cancelled" &&
          run.errorCode === "issue_not_in_progress");
      const health = await api("/health");
      expect(health).toMatchObject({
        status: "ok",
        deploymentMode: "local_trusted",
        bootstrapStatus: "ready",
        serverInfo: {
          git: {
            branchName: execFileSync("git", ["branch", "--show-current"], {
              cwd: root,
              encoding: "utf8",
            }).trim(),
          },
        },
      });
      const [company] = await api("/companies");
      let [agent] = await api(`/companies/${company.id}/agents`);
      expect(agent.adapterType).toBe("codex_local");
      expect(await api(`/companies/${company.id}/issues`)).toEqual([]);
      expect(await api(`/companies/${company.id}/heartbeat-runs`)).toEqual([]);
      expect(
        (await api(`/companies/${company.id}/tools/connections`)).connections,
      ).toEqual([]);
      diagnosticState = async () => ({
        base,
        companyId: company.id,
        agentId: agent.id,
        tasks: (await api(`/companies/${company.id}/issues`)).map(
          (task: Record<string, unknown>) => ({
            id: task.id,
            status: task.status,
            assigneeAgentId: task.assigneeAgentId,
          }),
        ),
        runs: (await api(`/companies/${company.id}/heartbeat-runs`)).map(
          (run: Record<string, unknown>) => ({
            id: run.id,
            status: run.status,
            runtimeMode: run.runtimeMode,
            error: run.error,
            errorCode: run.errorCode,
          }),
        ),
      });
      const dataDir = logs
        .match(/Data directory: ([^\n\r]+)/)![1]!
        .replace(/\u001b\[[0-9;]*m/g, "")
        .trim();
      await writeFile(
        info.outputPath("running-instance.json"),
        JSON.stringify(
          { base, dataDir, companyId: company.id, agentId: agent.id },
          null,
          2,
        ),
      );
      const prefix = `/${company.issuePrefix}`;
      await page.goto(base + prefix + "/dashboard");
      await expect(page.getByText("No runs yet").first()).toBeVisible({ timeout: 30_000 });
      if (journey === "legacy_unknown") {
        agent = await api(`/companies/${company.id}/agents`, "POST", {
          name: "Legacy executor", role: "engineer", adapterType: "process",
          adapterConfig: { command: process.execPath, args: ["-e", "console.error('Deterministic provider failure; no recoverable session contract'); process.exit(1)"] },
        });
        await page.getByRole("link", { name: "Tasks", exact: true }).click();
        await page.getByRole("button", { name: "New Task", exact: true }).last().click();
        await page.getByPlaceholder("Task title").fill("Read the legacy fixture report");
        await page.getByRole("button", { name: "Assignee", exact: true }).click();
        await page.getByRole("button", { name: agent.name, exact: true }).click();
        await page.getByRole("button", { name: "Create Task", exact: true }).click();
        await page.getByRole("complementary").getByRole("link", { name: /Read the legacy fixture report/ }).click();
        await expect.poll(async () => {
          const tasks = await api(`/companies/${company.id}/issues`);
          return tasks.find((issue: { title: string }) => issue.title === "Read the legacy fixture report")?.status;
        }, { timeout: 60_000 }).toBe("blocked");
        await expect(page.getByText("Blocked", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole("button", { name: "Reconcile and continue" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
        const composer = page.locator('[contenteditable="true"]').last();
        await composer.fill("Independent draft remains usable");
        await expect(composer).toContainText("Independent draft remains usable");
        await page.screenshot({ path: info.outputPath("legacy-recovery-needed.png"), fullPage: true });
        // Observe past the shared retry delay; absence of a successor is part
        // of the fail-closed contract, not merely a momentary UI state.
        await page.waitForTimeout(35_000);
        const runs = await api(`/companies/${company.id}/heartbeat-runs`);
        expect(runs).toHaveLength(1);
        expect(await api(`/heartbeat-runs/${runs[0].id}`)).toMatchObject({ runtimeMode: "legacy", status: "failed" });
        await page.reload();
        await expect(page.getByRole("button", { name: "Reconcile and continue" })).toHaveCount(0);
        await writeFile(info.outputPath("instance-and-runs.json"), JSON.stringify({ base, dataDir, health, dependency: "deterministic legacy process fixture", companyId: company.id, agentId: agent.id, runs }, null, 2));
        return;
      }
      await page.goto(
        base + prefix + "/company/settings/instance/experimental",
      );
      const nativeRunnerToggle = page.getByRole("switch", {
        name: "Toggle Paperclip Runner experimental setting",
      });
      // Fresh instances may already enable the native runner. Configure the
      // desired state instead of blindly toggling the current default off.
      if (await nativeRunnerToggle.getAttribute("aria-checked") !== "true") {
        await nativeRunnerToggle.click();
      }
      await expect(nativeRunnerToggle).toHaveAttribute("aria-checked", "true");
      await expect
        .poll(
          async () =>
            (await api("/instance/settings/experimental")).enableNativeRunner,
        )
        .toBe(true);
      await page.goto(base + prefix + `/agents/${agent.id}/configuration`);
      await page.getByRole("button", { name: "Codex", exact: true }).click();
      await page.getByRole("button", { name: /Paperclip Runner/ }).click();
      await page
        .getByRole("button", { name: /^Save(?: changes)?$/ })
        .first()
        .click();
      await expect
        .poll(async () => (await api(`/agents/${agent.id}`)).adapterType)
        .toBe("paperclip_runner");
      const nativeAgent = await api(`/agents/${agent.id}`);
      expect(nativeAgent.adapterConfig.env).toEqual(agent.adapterConfig.env);
      if (journey !== "ceo_lineage") {
        const { instructionsFilePath: _instructions, ...executorConfig } =
          nativeAgent.adapterConfig;
        agent = await api(`/companies/${company.id}/agents`, "POST", {
          name: "Executor",
          role: "engineer",
          adapterType: "paperclip_runner",
          adapterConfig: executorConfig,
        });
      }
      const holder = await api(`/companies/${company.id}/agents`, "POST", {
        name: "Archive holder",
        role: "qa",
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
      });
      const connections: Record<string, { id: string; name: string }> = {};
      for (const service of ["notion", "gmail"]) {
        await page.goto(base + prefix + "/apps");
        const custom = page
          .getByRole("list", { name: "Connector list" })
          .getByRole("listitem")
          .filter({ hasText: "Connect your own tool" });
        await custom
          .getByRole("button", { name: "Connect", exact: true })
          .click();
        await custom
          .getByRole("button", { name: "Connect your own MCP server" })
          .click();
        await page
          .getByPlaceholder("https://example.com/actions")
          .fill(`http://127.0.0.1:${port}/${service}`);
        await page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        await page.getByRole("radio", { name: "Just agents I pick" }).click();
        await page.getByRole("button", { name: /Select agents/ }).click();
        await page.getByRole("checkbox", { name: /Archive holder/ }).check();
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Save and continue" }).click();
        await page.getByRole("button", { name: /Check link/i }).click();
        await expect(
          page.getByRole("heading", { name: /is ready/i }),
        ).toBeVisible({ timeout: 30_000 });
        const connection = (
          await api(`/companies/${company.id}/tools/connections`)
        ).connections.find(
          (row: { id: string }) =>
            !Object.values(connections).some(
              (existing) => existing.id === row.id,
            ),
        );
        connections[service] = connection;
        const installs = (
          await api(`/tool-connections/${connection.id}/installs`)
        ).installs;
        expect(installs).toEqual([
          expect.objectContaining({ targetId: holder.id }),
        ]);
      }
      await page.getByRole("link", { name: "Tasks", exact: true }).click();
      await page
        .getByRole("button", { name: "New Task", exact: true })
        .last()
        .click();
      await page
        .getByPlaceholder("Task title")
        .fill(
          `${journey === "ceo_lineage" ? "CEO descendant fixture: " : ""}Find the heliotrope launch notes and summarize the decisions with a source link`,
        );
      await page.getByRole("button", { name: "Assignee", exact: true }).click();
      await page.getByRole("button", { name: agent.name, exact: true }).click();
      await page
        .getByRole("button", { name: "Create Task", exact: true })
        .click();
      await page
        .getByRole("complementary")
        .getByRole("link", { name: /Find the heliotrope launch notes/ })
        .click();
      await expect(page).toHaveURL(/issues\/(?:[a-f0-9-]+|[A-Z]+-\d+)/);
      const connectPending = async (service: "notion" | "gmail") => {
        const connection = connections[service]!;
        const card = page
          .getByTestId("connection-intent-focus-target")
          .filter({ hasText: connection.name });
        await expect(
          card.getByRole("button", { name: /Connect \/ Use existing/ }),
        ).toBeVisible({ timeout: 60_000 });
        await page.screenshot({
          path: info.outputPath(`${service}-pending.png`),
          fullPage: true,
        });
        await card
          .getByRole("button", { name: /Connect \/ Use existing/ })
          .click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page
          .getByRole("dialog")
          .getByRole("button", { name: new RegExp(connection.name) })
          .click();
        await expect(
          card.getByText(`${connection.name} connected`, { exact: true }),
        ).toBeVisible({ timeout: 30_000 });
      };
      if (journey === "ceo_lineage")
        await expect(
          page
            .getByText("Provider child finished; root execution continues.", {
              exact: true,
            })
            .first(),
        ).toBeVisible({ timeout: 60_000 });
      await connectPending("notion");
      await expect(
        page.getByText(/HELIOTROPE-42: Launch in two stages/).first(),
      ).toBeVisible({ timeout: 60_000 });
      await expect
        .poll(
          async () =>
            (await api(`/companies/${company.id}/heartbeat-runs`)).every(
              isSettledRun,
            ),
          { timeout: 60_000 },
        )
        .toBe(true);
      const [task] = await api(`/companies/${company.id}/issues`);
      const originalTitle = task.title;
      await page
        .getByRole("textbox")
        .last()
        .fill(
          "Now summarize my Gmail emails about launch decisions, with the source link.",
        );
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await connectPending("gmail");
      if (journey === "safe_restart") {
        await expect
          .poll(
            async () =>
              (await api(`/companies/${company.id}/heartbeat-runs`)).some(
                (run: { status: string; scheduledRetryReason?: string }) =>
                  run.status === "scheduled_retry" &&
                  run.scheduledRetryReason === "native_safe_replacement",
              ),
            { timeout: 45_000 },
          )
          .toBe(true);
        await page.screenshot({
          path: info.outputPath("retry-before-restart.png"),
          fullPage: true,
        });
        await stopDrive();
        const startOffset = logs.length;
        processHandle = spawn(
          process.execPath,
          [
            "cli/node_modules/tsx/dist/cli.mjs",
            "cli/src/index.ts",
            "test-drive",
            "--data-dir",
            dataDir,
            "--harness",
            "codex",
            "--api-key-env",
            "IN_FEED_FIXTURE_KEY",
            "--no-browser",
          ],
          { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        processHandle.stdout!.on("data", (chunk) => {
          logs += chunk.toString();
        });
        processHandle.stderr!.on("data", (chunk) => {
          logs += chunk.toString();
        });
        await expect
          .poll(
            () =>
              logs
                .slice(startOffset)
                .match(
                  /Paperclip is ready at (http:\/\/127\.0\.0\.1:\d+)/,
                )?.[1],
            { timeout: 100_000 },
          )
          .toBeTruthy();
        base = logs
          .slice(startOffset)
          .match(/Paperclip is ready at (http:\/\/127\.0\.0\.1:\d+)/)![1]!;
        expect((await api("/health")).serverInfo.git.branchName).toBe(
          health.serverInfo.git.branchName,
        );
        expect((await api("/companies"))[0].id).toBe(company.id);
        await page.goto(base + prefix + `/issues/${task.id}`);
      }
      const composer = page.getByRole("textbox").last();
      await composer.fill("An unsent draft stays available during recovery.");
      await expect(composer).toBeEditable();
      if (journey !== "uncertain") {
        await expect(
          page
            .getByText(/GMAIL-73: The launch email confirms Friday approval/)
            .first(),
        ).toBeVisible({ timeout: 100_000 });
        expect(gmailReadCount).toBe(journey === "ceo_lineage" ? 1 : 2);
      } else {
        await expect.poll(async () => (await api(`/issues/${task.id}`)).status, { timeout: 100_000 }).toBe("blocked");
        await expect(page.getByText("Blocked", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
        expect(gmailReadCount).toBe(1);
        await expect(page.getByText(/GMAIL-73/)).toHaveCount(0);
        await expect(page.getByRole("button", { name: /Reconcile and continue|Try again/ })).toHaveCount(0);
        await expect(page.getByRole("dialog", { name: "Reconcile execution" })).toHaveCount(0);
        const recovery = (await api(`/issues/${task.id}`)).activeRecoveryAction;
        expect(recovery).toBeNull();
        await page.screenshot({ path: info.outputPath("uncertain-automatic-no-replay.png"), fullPage: true });
        // Past the retry delay, unknown effects still cannot be replayed.
        await page.waitForTimeout(35_000);
        expect(gmailReadCount).toBe(1);
      }
      await expect(composer).toHaveText(
        "An unsent draft stays available during recovery.",
      );
      await expect
        .poll(
          async () =>
            (await api(`/companies/${company.id}/heartbeat-runs`)).every(
              (run: { status: string }) =>
                !["running", "queued", "scheduled_retry"].includes(run.status),
            ),
          { timeout: 60_000 },
        )
        .toBe(true);
      if (journey !== "uncertain") await expect(async () => {
        const answer = page.getByText(/GMAIL-73: The launch email confirms Friday approval/).first();
        // Refresh can replace the streamed row with its persisted transcript.
        // Re-resolve the locator if that handoff detaches it during scrolling.
        await answer.scrollIntoViewIfNeeded();
        await expect(answer).toBeInViewport();
      }).toPass({ timeout: 10_000 });
      await page.screenshot({
        path: info.outputPath(`${journey}-outcome.png`),
        fullPage: true,
      });
      const finalRuns = await Promise.all(
        (await api(`/companies/${company.id}/heartbeat-runs`)).map(
          (run: { id: string }) => api(`/heartbeat-runs/${run.id}`),
        ),
      );
      const replacements = finalRuns.filter(
        (run: { scheduledRetryReason?: string }) =>
          run.scheduledRetryReason === "native_safe_replacement",
      );
      expect(replacements).toHaveLength(
        journey === "safe" || journey === "safe_restart" ? 1 : 0,
      );
      expect(
        finalRuns.every(
          (run: { runtimeMode: string }) => run.runtimeMode === "native",
        ),
      ).toBe(true);
      expect(
        finalRuns.some((run: { status: string }) => run.status === "running"),
      ).toBe(false);
      expect((await api(`/issues/${task.id}`)).title).toBe(originalTitle);
      await composer.fill("");
      await page.reload();
      await expect(page.getByText(/Due now/, { exact: true })).toHaveCount(0);
      if (journey !== "uncertain") await expect(
        page
          .getByText(/GMAIL-73: The launch email confirms Friday approval/)
          .first(),
      ).toBeVisible();
      else {
        expect((await api(`/issues/${task.id}`)).status).toBe("blocked");
        await expect(page.getByRole("button", { name: "Reconcile and continue" })).toHaveCount(0);
      }
      if (journey !== "uncertain") await expect(async () => {
        const answer = page.getByText(/GMAIL-73: The launch email confirms Friday approval/).first();
        // Refresh can replace the streamed row with its persisted transcript.
        // Re-resolve the locator if that handoff detaches it during scrolling.
        await answer.scrollIntoViewIfNeeded();
        await expect(answer).toBeInViewport();
      }).toPass({ timeout: 10_000 });
      await page.screenshot({
        path: info.outputPath(`${journey}-after-refresh.png`),
        fullPage: true,
      });
      const evidence = JSON.stringify(
        {
          base,
          dataDir,
          health,
          journey,
          companyId: company.id,
          agentId: agent.id,
          taskId: task.id,
          connections,
          runs: finalRuns.map((run: Record<string, unknown>) => ({
            id: run.id,
            runtimeMode: run.runtimeMode,
            status: run.status,
            retryOfRunId: run.retryOfRunId,
            errorCode: run.errorCode,
            execution: run.execution,
          })),
          dependency: "fixture",
          provider: "codex",
          fixtureModel: "in-feed-fixture",
          calls,
        },
        null,
        2,
      );
      await writeFile(info.outputPath("instance-and-runs.json"), evidence);
      await info.attach("instance-and-runs", {
        body: evidence,
        contentType: "application/json",
      });
    } finally {
      await writeFile(
        info.outputPath("diagnostics.json"),
        JSON.stringify(await diagnosticState().catch(() => ({})), null, 2),
      );
      await writeFile(info.outputPath("test-drive.log"), logs);
      await stopDrive();
      fixture.closeAllConnections();
      await new Promise<void>((done) => fixture.close(() => done()));
    }
  });
