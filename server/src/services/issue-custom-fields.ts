import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueCustomFields, issues, plugins } from "@paperclipai/db";
import type { IssueCustomField } from "@paperclipai/plugin-sdk";
import type { IssueCustomFieldType } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";

const FIELD_KEY_RE = /^[a-z][a-z0-9_-]*$/;
const NUMBER_RE = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const ALLOWED_URL_SCHEMES = new Set(["http:", "https:"]);

function validateFieldKey(key: string): void {
  if (!FIELD_KEY_RE.test(key)) {
    throw unprocessable("Invalid field key: must match ^[a-z][a-z0-9_-]*$");
  }
}

function validateAndCoerceValue(
  value: string,
  fieldType: IssueCustomFieldType,
): { valueText: string; valueNumber: number | null } {
  switch (fieldType) {
    case "text":
    case "enum-ref":
      return { valueText: value, valueNumber: null };

    case "number": {
      if (!NUMBER_RE.test(value.trim())) {
        throw unprocessable("Invalid number value: must be a valid numeric string");
      }
      const n = parseFloat(value);
      if (!isFinite(n)) {
        throw unprocessable("Invalid number value: must be a finite number");
      }
      return { valueText: value, valueNumber: n };
    }

    case "url": {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        throw unprocessable(`Invalid URL value: could not parse '${value}'`);
      }
      if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
        throw unprocessable(
          `Invalid URL scheme '${parsed.protocol}': only http and https are allowed`,
        );
      }
      return { valueText: value, valueNumber: null };
    }
  }
}

export function issueCustomFieldService(db: Db) {
  return {
    async set(params: {
      companyId: string;
      issueId: string;
      pluginId: string;
      key: string;
      value: string;
      fieldType: IssueCustomFieldType;
      fieldLabel: string;
    }): Promise<void> {
      const { companyId, issueId, pluginId, key, value, fieldType, fieldLabel } = params;

      validateFieldKey(key);
      const { valueText, valueNumber } = validateAndCoerceValue(value, fieldType);

      await db.transaction(async (tx) => {
        // Tenant guard: verify issue belongs to this company
        const issueRow = await tx
          .select({ id: issues.id })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
          .for("update")
          .limit(1);
        if (issueRow.length === 0) {
          throw notFound(`Issue ${issueId} not found or unauthorized for company ${companyId}`);
        }

        // Soft-delete any live row for this (company, issue, plugin, key) tuple
        await tx
          .update(issueCustomFields)
          .set({ deletedAt: sql`now()`, deletedByPluginId: pluginId })
          .where(
            and(
              eq(issueCustomFields.companyId, companyId),
              eq(issueCustomFields.issueId, issueId),
              eq(issueCustomFields.pluginId, pluginId),
              eq(issueCustomFields.fieldKey, key),
              isNull(issueCustomFields.deletedAt),
            ),
          );

        // Insert the new live row
        await tx.insert(issueCustomFields).values({
          companyId,
          issueId,
          pluginId,
          fieldKey: key,
          fieldType,
          fieldLabel,
          valueText,
          valueNumber: valueNumber !== null ? String(valueNumber) : null,
        });
      });
    },

    async unset(params: {
      companyId: string;
      issueId: string;
      pluginId: string;
      key: string;
    }): Promise<boolean> {
      const { companyId, issueId, pluginId, key } = params;

      const updated = await db
        .update(issueCustomFields)
        .set({ deletedAt: sql`now()`, deletedByPluginId: pluginId })
        .where(
          and(
            eq(issueCustomFields.companyId, companyId),
            eq(issueCustomFields.issueId, issueId),
            eq(issueCustomFields.pluginId, pluginId),
            eq(issueCustomFields.fieldKey, key),
            isNull(issueCustomFields.deletedAt),
          ),
        )
        .returning({ id: issueCustomFields.id });
      return updated.length > 0;
    },

    async listForIssue(params: {
      companyId: string;
      issueId: string;
      pluginId: string;
    }): Promise<IssueCustomField[]> {
      const { companyId, issueId, pluginId } = params;

      const rows = await db
        .select()
        .from(issueCustomFields)
        .where(
          and(
            eq(issueCustomFields.companyId, companyId),
            eq(issueCustomFields.issueId, issueId),
            eq(issueCustomFields.pluginId, pluginId),
            isNull(issueCustomFields.deletedAt),
          ),
        );

      return rows.map((row) => ({
        pluginId: row.pluginId,
        pluginKey: "",
        pluginDisplayName: "",
        key: row.fieldKey,
        type: row.fieldType as IssueCustomFieldType,
        label: row.fieldLabel,
        valueText: row.valueText ?? null,
        valueNumber: row.valueNumber !== null ? Number(row.valueNumber) : null,
      }));
    },

    async listForIssuesBatch(params: {
      companyId: string;
      issueIds: string[];
      pluginId: string;
    }): Promise<Map<string, IssueCustomField[]>> {
      const { companyId, issueIds, pluginId } = params;

      if (issueIds.length === 0) return new Map();

      const rows = await db
        .select()
        .from(issueCustomFields)
        .where(
          and(
            eq(issueCustomFields.companyId, companyId),
            inArray(issueCustomFields.issueId, issueIds),
            eq(issueCustomFields.pluginId, pluginId),
            isNull(issueCustomFields.deletedAt),
          ),
        );

      const result = new Map<string, IssueCustomField[]>();
      for (const row of rows) {
        const list = result.get(row.issueId) ?? [];
        list.push({
          pluginId: row.pluginId,
          pluginKey: "",
          pluginDisplayName: "",
          key: row.fieldKey,
          type: row.fieldType as IssueCustomFieldType,
          label: row.fieldLabel,
          valueText: row.valueText ?? null,
          valueNumber: row.valueNumber !== null ? Number(row.valueNumber) : null,
        });
        result.set(row.issueId, list);
      }
      return result;
    },

    async listAllForIssue(params: {
      companyId: string;
      issueId: string;
    }): Promise<IssueCustomField[]> {
      const { companyId, issueId } = params;

      const rows = await db
        .select({
          pluginId: issueCustomFields.pluginId,
          pluginKey: plugins.pluginKey,
          manifestJson: plugins.manifestJson,
          key: issueCustomFields.fieldKey,
          type: issueCustomFields.fieldType,
          label: issueCustomFields.fieldLabel,
          valueText: issueCustomFields.valueText,
          valueNumber: issueCustomFields.valueNumber,
        })
        .from(issueCustomFields)
        .innerJoin(plugins, eq(issueCustomFields.pluginId, plugins.id))
        .where(
          and(
            eq(issueCustomFields.companyId, companyId),
            eq(issueCustomFields.issueId, issueId),
            isNull(issueCustomFields.deletedAt),
          ),
        );

      return rows.map((row) => ({
        pluginId: row.pluginId,
        pluginKey: row.pluginKey,
        pluginDisplayName: (row.manifestJson as { displayName?: string })?.displayName ?? row.pluginKey,
        key: row.key,
        type: row.type as IssueCustomFieldType,
        label: row.label,
        valueText: row.valueText ?? null,
        valueNumber: row.valueNumber !== null ? Number(row.valueNumber) : null,
      }));
    },
  };
}
