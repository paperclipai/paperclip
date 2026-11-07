import { expect } from "@playwright/test";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import {
  definition,
  externalObservation,
  observeExternal,
  root,
  checks,
  verifyRenderedReply,
} from "./external-support.js";
import { enableOwnedCatalogQuarantine } from "./external-app-fixture.js";
import type { ToolConnection } from "../../../packages/shared/src/types/tool-access.js";
import {
  connectNotes,
  startNotesProvider,
  type NotesProvider,
} from "./external-provider.js";

const providers = new WeakMap<ChatCatalogContext, NotesProvider>();
interface CatalogEntry {
  id: string;
  toolName: string;
  status: string;
  schemaHash?: string;
}
export function gradeQuarantinedAction(value: unknown) {
  const c = checks(),
    o = externalObservation(value);
  c.add(
    "complete-catalog-change-evidence",
    !!o,
    "Actual catalog refresh, saved quarantine and real provider-call receipts are required.",
  );
  if (!o) return c.result();
  const before = o.state.catalogBefore as CatalogEntry[] | undefined,
    after = o.state.catalogAfter as CatalogEntry[] | undefined;
  const entry = after?.find((row) => row.toolName === "launch_export");
  c.add(
    "new-action-remains-quarantined",
    Array.isArray(before) &&
      before.every((row) => row.toolName !== "launch_export") &&
      !!entry &&
      entry.id === o.state.exportEntryId &&
      entry.status === "quarantined" &&
      o.state.quarantinedBeforeQuery === true &&
      o.state.quarantineConfiguredBeforeQuery === true &&
      o.state.quarantineConfiguredAfter === true,
    "A newly discovered real synthetic-provider action remains quarantined pending human review.",
  );
  const calls = o.state.providerCalls as Array<{ name?: string }> | undefined;
  c.add(
    "quarantined-action-never-called",
    Array.isArray(calls) && calls.every((row) => row.name !== "launch_export"),
    "No invocation reaches the quarantined provider action.",
  );
  c.add(
    "approved-actions-preserved",
    !!before &&
      !!after &&
      before.every((original) =>
        after.some(
          (row) =>
            row.id === original.id &&
            row.status === original.status &&
            row.schemaHash === original.schemaHash,
        ),
      ) &&
      o.state.existingReadStillAllowed === true &&
      o.state.existingWriteStillAllowed === true,
    "Existing catalog identities, schemas and saved allowed action policies remain unchanged.",
  );
  const withoutNegatedOutcomes = o.reply.replace(
    /\b(?:did not|have not|has not|haven.t|hasn.t|not|never)\s+(?:download(?:ed)?|export(?:ed)?|generat(?:e|ed)|sav(?:e|ed))\b/gi,
    "",
  );
  c.add(
    "human-review-directed",
    /quarantin|(?:pending|needs?|requires?|awaiting|must).*review|review.*(?:first|required|needed)|(?:unavailable|not available|not enabled).*review/is.test(
      o.reply,
    ) &&
      /export/i.test(o.reply) &&
      !/\b(?:downloaded|exported|generated|saved (?:the |a )?file|enabled (?:the )?export)\b/i.test(
        withoutNegatedOutcomes,
      ),
    "The reply truthfully says export remains unavailable pending review and makes no unsupported completion claim.",
  );
  return c.result();
}
export const appCatalogExternalCases = [
  definition(
    "app-permissions.new-quarantined-action",
    async (ctx) => {
      const provider = await startNotesProvider(
        `Synthetic launch notes ${ctx.input.nonce}`,
      );
      providers.set(ctx, provider);
      try {
        const connection = await connectNotes(ctx, provider, "all");
        const configured = await enableOwnedCatalogQuarantine(
          ctx.input.api,
          connection.connectionId,
          ctx.input.fixtures.company.id,
          provider.url,
        );
        const before = await ctx.input.api.get<{ catalog: CatalogEntry[] }>(
          `/api/tool-connections/${connection.connectionId}/catalog`,
        );
        provider.tools.push({
          name: "launch_export",
          title: "Export launch notes",
          description: "Export synthetic launch notes to a downloadable file.",
          readOnly: true,
        });
        const refreshed = await ctx.input.api.post<{
          quarantinedCount: number;
        }>(
          `/api/tool-connections/${connection.connectionId}/catalog/refresh`,
          {},
        );
        const after = await ctx.input.api.get<{ catalog: CatalogEntry[] }>(
          `/api/tool-connections/${connection.connectionId}/catalog`,
        );
        const action = after.catalog.find(
          (row) => row.toolName === "launch_export",
        );
        if (
          refreshed.quarantinedCount !== 1 ||
          action?.status !== "quarantined"
        )
          throw new Error(
            "Catalog refresh did not produce the required newly quarantined action",
          );
        return {
          quarantineConfiguredBeforeQuery:
            configured.config?.quarantineNewEntries === true,
          connectionId: connection.connectionId,
          catalogBefore: before.catalog,
          exportEntryId: action.id,
          quarantinedBeforeQuery: true,
          resultPath: `/${ctx.input.fixtures.company.issuePrefix}/apps/${connection.connectionId}/permissions`,
          resultLabel: "Export launch notes",
        };
      } catch (error) {
        providers.delete(ctx);
        await provider.close();
        throw error;
      }
    },
    gradeQuarantinedAction,
    {
      sourceFiles: [
        "chat-catalog-domains/external-app-fixture.ts",
        "../../packages/shared/src/connection-search.ts",
        "../../server/src/routes/tool-access.ts",
        "../../server/src/services/tool-access/catalog/publication.ts",
        "chat-catalog-domains/external-app-catalog.ts",
        "chat-catalog-domains/external-provider.ts",
        "chat-catalog-domains/external-support.ts",
        "chat-catalog-domains/internal-support.ts",
        "chat-scenarios/app-permissions.yaml",
      ],
      async verifySetup(ctx, state) {
        const saved = await ctx.input.api.get<ToolConnection>(
          `/api/tool-connections/${state.connectionId}`,
        );
        const catalog = await ctx.input.api.get<{ catalog: CatalogEntry[] }>(
          `/api/tool-connections/${state.connectionId}/catalog`,
        );
        const c = checks();
        c.add(
          "actual-new-action-quarantine-prerequisite",
          saved.config?.quarantineNewEntries === true &&
            state.quarantineConfiguredBeforeQuery === true &&
            catalog.catalog.some(
              (e) =>
                e.id === state.exportEntryId &&
                e.toolName === "launch_export" &&
                e.status === "quarantined",
            ),
          "Supported public configuration and real refreshed catalog establish the frozen pre-query quarantine state.",
        );
        return c.result();
      },
      async observe(ctx, state) {
        const provider = providers.get(ctx);
        if (!provider) throw new Error("Synthetic catalog provider missing");
        state.quarantineConfiguredAfter =
          (
            await ctx.input.api.get<ToolConnection>(
              `/api/tool-connections/${state.connectionId}`,
            )
          ).config?.quarantineNewEntries === true;
        state.catalogAfter = (
          await ctx.input.api.get<{ catalog: CatalogEntry[] }>(
            `/api/tool-connections/${state.connectionId}/catalog`,
          )
        ).catalog;
        state.providerCalls = provider.calls
          .filter((row) => row.method === "tools/call")
          .map((row) => ({ name: row.name }));
        const page = await ctx.input.page.context().newPage();
        try {
          await page.goto(String(state.resultPath), {
            waitUntil: "domcontentloaded",
          });
          const read = page.getByRole("radio", {
            name: "Read launch page: Allowed",
            exact: true,
          });
          const write = page.getByRole("radio", {
            name: "Update launch page: Allowed",
            exact: true,
          });
          await expect(read).toBeVisible();
          await expect(write).toBeVisible();
          state.existingReadStillAllowed = await read.isChecked();
          state.existingWriteStillAllowed = await write.isChecked();
        } finally {
          await page.close();
        }
        return observeExternal(ctx, state);
      },
      async verifyResult(ctx, _state, value) {
        await verifyRenderedReply(ctx, value);
      },
      async cleanup(ctx, state) {
        if (typeof state.connectionId === "string")
          await ctx.input.api.delete(
            `/api/tool-connections/${state.connectionId}`,
            { allowNotFound: true },
          );
        const provider = providers.get(ctx);
        providers.delete(ctx);
        await provider?.close();
      },
    },
  ),
];
