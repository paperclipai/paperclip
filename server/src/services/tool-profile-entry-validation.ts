import { toolApplications, toolCatalogEntries, toolConnections, type Db } from "@paperclipai/db";
import type { CreateToolProfileEntryForProfile } from "@paperclipai/shared";
import { and, eq, inArray, or } from "drizzle-orm";
import { badRequest, notFound, unprocessable } from "../errors.js";

const UUID_IDENTIFIER = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFERENCE_BATCH_SIZE = 500;

function* referenceBatches(values: string[]) {
  for (let index = 0; index < values.length; index += REFERENCE_BATCH_SIZE) {
    yield values.slice(index, index + REFERENCE_BATCH_SIZE);
  }
}

export function assertProfileEntryShape(input: CreateToolProfileEntryForProfile) {
  if (input.selectorType === "application" && !input.applicationId) {
    throw badRequest("Application profile entries require applicationId");
  }
  if (input.selectorType === "connection" && !input.connectionId) {
    throw badRequest("Connection profile entries require connectionId");
  }
  if (input.selectorType === "catalog_entry" && !input.catalogEntryId) {
    throw badRequest("Catalog-entry profile entries require catalogEntryId");
  }
  if (input.selectorType === "tool_name" && !input.toolName) {
    throw badRequest("Tool-name profile entries require toolName");
  }
  if (input.selectorType === "risk_level" && !input.riskLevel) {
    throw badRequest("Risk-level profile entries require riskLevel");
  }
}

export async function assertProfileEntryInputs(
  db: Pick<Db, "select">,
  companyId: string,
  entries: CreateToolProfileEntryForProfile[],
) {
  const applications = new Set<string>();
  const connectionIds = new Set<string>();
  const connectionUids = new Set<string>();
  const catalogEntries = new Set<string>();
  const references = (key: "applicationId" | "connectionId" | "catalogEntryId") =>
    [...new Set(entries.flatMap(entry => entry[key] ? [entry[key]!] : []))];

  for (const ids of referenceBatches(references("applicationId"))) {
    const rows = await db.select({ id: toolApplications.id }).from(toolApplications)
      .where(and(eq(toolApplications.companyId, companyId), inArray(toolApplications.id, ids)));
    for (const row of rows) applications.add(row.id.toLowerCase());
  }
  for (const refs of referenceBatches(references("connectionId"))) {
    const ids = refs.filter(value => UUID_IDENTIFIER.test(value));
    const uids = refs.filter(value => !UUID_IDENTIFIER.test(value));
    const rows = await db.select({ id: toolConnections.id, uid: toolConnections.uid }).from(toolConnections)
      .where(and(eq(toolConnections.companyId, companyId), or(
        ids.length ? inArray(toolConnections.id, ids) : undefined,
        uids.length ? inArray(toolConnections.uid, uids) : undefined,
      )));
    for (const row of rows) {
      connectionIds.add(row.id.toLowerCase());
      connectionUids.add(row.uid);
    }
  }
  for (const ids of referenceBatches(references("catalogEntryId"))) {
    const rows = await db.select({ id: toolCatalogEntries.id }).from(toolCatalogEntries)
      .where(and(eq(toolCatalogEntries.companyId, companyId), inArray(toolCatalogEntries.id, ids)));
    for (const row of rows) catalogEntries.add(row.id.toLowerCase());
  }

  for (const entry of entries) {
    assertProfileEntryShape(entry);
    if (entry.applicationId && !applications.has(entry.applicationId.toLowerCase())) {
      throw notFound("Tool application not found");
    }
    if (entry.connectionId && !(UUID_IDENTIFIER.test(entry.connectionId)
      ? connectionIds.has(entry.connectionId.toLowerCase()) : connectionUids.has(entry.connectionId))) {
      throw notFound("Tool connection not found");
    }
    if (entry.catalogEntryId && !catalogEntries.has(entry.catalogEntryId.toLowerCase())) {
      throw unprocessable("Tool profile catalog entry selector must belong to the same company");
    }
  }
}
