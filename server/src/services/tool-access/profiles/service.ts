import { assertProfileEntryInputs } from "../../tool-profile-entry-validation.js";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues, projects, routines, toolApplications, toolCatalogEntries, toolConnections, toolMcpGateways, toolProfileBindings, toolProfileEntries, toolProfiles } from "@paperclipai/db";
import type { CreateToolProfileBindingForProfile, CreateToolProfileEntryForProfile, CreateToolProfileWithEntries, DeleteToolProfile, DuplicateToolProfile, ToolProfile, ToolProfileBinding, ToolProfileEntry, ToolProfileNewToolReviewItem, ToolProfileNewToolsReview, ToolProfileNewToolsReviewResult, ToolProfileSummary, ToolProfileWithDetails, ReviewToolProfileNewTools, UpdateToolProfileEntry, UpdateToolProfileWithEntries, UnbindToolProfileBinding } from "@paperclipai/shared";
import { badRequest, conflict, notFound, unprocessable } from "../../../errors.js";
import type { ActorInfo, ToolAccessMutationDb } from "../types.js";
import { lockProfileEntryReferences, lockToolAssignmentAgents } from "../assignment-locks.js";
import { normalizeKey } from "../identifiers.js";
import { toProfile, toProfileEntry, toProfileBinding, profileCatalogColumns, profileReviewCatalogColumns, pendingNewToolsForProfile, buildProfileDetails } from "./projection.js";

export function createToolProfileService(db: Db, now: () => Date) {
  async function getProfileRow(profileId: string, companyId?: string, dbClient: ToolAccessMutationDb = db) {
    const where = companyId
      ? and(
          eq(toolProfiles.id, profileId),
          eq(toolProfiles.companyId, companyId),
        )
      : eq(toolProfiles.id, profileId);
    const [row] = await dbClient.select().from(toolProfiles).where(where);
    if (!row) throw notFound("Tool profile not found");
    return row;
  }

  async function profileDetails(
    profileId: string,
    companyId?: string,
    dbClient: ToolAccessMutationDb = db,
  ): Promise<ToolProfileWithDetails> {
    const profile = await getProfileRow(profileId, companyId, dbClient);
    const [
      entries,
      bindings,
      catalog,
      companyAgents,
      applications,
      connections,
    ] = await Promise.all([
      dbClient
        .select()
        .from(toolProfileEntries)
        .where(
          and(
            eq(toolProfileEntries.companyId, profile.companyId),
            eq(toolProfileEntries.profileId, profile.id),
          ),
        )
        .orderBy(asc(toolProfileEntries.createdAt)),
      dbClient
        .select()
        .from(toolProfileBindings)
        .where(
          and(
            eq(toolProfileBindings.companyId, profile.companyId),
            eq(toolProfileBindings.profileId, profile.id),
          ),
        )
        .orderBy(
          asc(toolProfileBindings.priority),
          asc(toolProfileBindings.createdAt),
        ),
      dbClient
        .select(profileCatalogColumns)
        .from(toolCatalogEntries)
        .where(
          and(
            eq(toolCatalogEntries.companyId, profile.companyId),
            eq(toolCatalogEntries.status, "active"),
          ),
        ),
      dbClient
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.companyId, profile.companyId)),
      dbClient
        .select({ id: toolApplications.id, name: toolApplications.name })
        .from(toolApplications)
        .where(eq(toolApplications.companyId, profile.companyId)),
      dbClient
        .select({ id: toolConnections.id, name: toolConnections.name })
        .from(toolConnections)
        .where(eq(toolConnections.companyId, profile.companyId)),
    ]);
    return buildProfileDetails({
      profile,
      entries,
      bindings,
      catalog,
      agentIds: companyAgents.map((agent) => agent.id),
      applicationsById: new Map(
        applications.map((application) => [application.id, application]),
      ),
      connectionsById: new Map(
        connections.map((connection) => [connection.id, connection]),
      ),
    });
  }

  async function listProfileNewTools(
    profileId: string,
    companyId?: string,
  ): Promise<ToolProfileNewToolsReview> {
    const profile = await getProfileRow(profileId, companyId);
    const [entries, catalog, applications, connections] = await Promise.all([
      db
        .select()
        .from(toolProfileEntries)
        .where(
          and(
            eq(toolProfileEntries.companyId, profile.companyId),
            eq(toolProfileEntries.profileId, profile.id),
          ),
        )
        .orderBy(asc(toolProfileEntries.createdAt)),
      db
        .select(profileReviewCatalogColumns)
        .from(toolCatalogEntries)
        .where(
          and(
            eq(toolCatalogEntries.companyId, profile.companyId),
            eq(toolCatalogEntries.status, "active"),
          ),
        )
        .orderBy(asc(toolCatalogEntries.toolName)),
      db
        .select({ id: toolApplications.id, name: toolApplications.name })
        .from(toolApplications)
        .where(eq(toolApplications.companyId, profile.companyId)),
      db
        .select({ id: toolConnections.id, name: toolConnections.name })
        .from(toolConnections)
        .where(eq(toolConnections.companyId, profile.companyId)),
    ]);
    const tools = pendingNewToolsForProfile({
      profile,
      entries,
      catalog,
      applicationsById: new Map(
        applications.map((application) => [application.id, application]),
      ),
      connectionsById: new Map(
        connections.map((connection) => [connection.id, connection]),
      ),
    });
    return {
      profileId: profile.id,
      reviewedAt: profile.newToolsReviewedAt,
      pendingCount: tools.length,
      tools,
    };
  }

  async function reviewProfileNewTools(
    profileId: string,
    input: ReviewToolProfileNewTools,
    actor?: ActorInfo,
  ): Promise<ToolProfileNewToolsReviewResult> {
    const profile = await getProfileRow(profileId);
    const review = await listProfileNewTools(profile.id, profile.companyId);
    if (review.tools.length === 0)
      throw badRequest("No new tools are pending review for this profile");

    const decisionIds = input.decisions.map(
      (decision) => decision.catalogEntryId,
    );
    if (new Set(decisionIds).size !== decisionIds.length) {
      throw badRequest(
        "New-tools review decisions must not contain duplicate catalogEntryId values",
      );
    }
    const pendingIds = new Set(review.tools.map((tool) => tool.catalogEntryId));
    if (
      decisionIds.length !== pendingIds.size ||
      decisionIds.some((id) => !pendingIds.has(id))
    ) {
      throw badRequest(
        "New-tools review decisions must cover every currently pending tool exactly once",
      );
    }

    const toolById = new Map(
      review.tools.map((tool) => [tool.catalogEntryId, tool]),
    );
    const allowTools = input.decisions
      .filter((decision) => decision.decision === "allow")
      .map((decision) => toolById.get(decision.catalogEntryId))
      .filter(Boolean) as ToolProfileNewToolReviewItem[];
    const nowAt = now();
    let createdEntries: ToolProfileEntry[] = [];
    if (allowTools.length > 0) {
      const rows = await db
        .insert(toolProfileEntries)
        .values(
          allowTools.map((tool) => ({
            companyId: profile.companyId,
            profileId: profile.id,
            selectorType: "catalog_entry" as const,
            effect: "include" as const,
            applicationId: tool.applicationId,
            connectionId: tool.connectionId,
            catalogEntryId: tool.catalogEntryId,
          })),
        )
        .returning();
      createdEntries = rows.map(toProfileEntry);
    }

    await db
      .update(toolCatalogEntries)
      .set({
        reviewedAt: nowAt,
        reviewedByAgentId:
          actor?.actorType === "agent" ? (actor.actorId ?? null) : null,
        reviewedByUserId:
          actor?.actorType === "user" ? (actor.actorId ?? null) : null,
        updatedAt: nowAt,
      })
      .where(
        and(
          eq(toolCatalogEntries.companyId, profile.companyId),
          inArray(toolCatalogEntries.id, decisionIds),
        ),
      );
    await db
      .update(toolProfiles)
      .set({ newToolsReviewedAt: nowAt, updatedAt: nowAt })
      .where(eq(toolProfiles.id, profile.id));

    return {
      profile: await profileDetails(profile.id, profile.companyId),
      reviewedAt: nowAt,
      allowedCount: allowTools.length,
      keptBlockedCount: input.decisions.length - allowTools.length,
      entriesCreated: createdEntries,
      reviewedCatalogEntryIds: decisionIds,
    };
  }

  async function createProfileEntries(
    companyId: string,
    profileId: string,
    entries: CreateToolProfileEntryForProfile[],
    dbClient: ToolAccessMutationDb = db,
  ) {
    await assertProfileEntryInputs(dbClient, companyId, entries);
    if (entries.length === 0) return;
    await dbClient.insert(toolProfileEntries).values(
      entries.map((entry) => ({
        companyId,
        profileId,
        selectorType: entry.selectorType,
        effect: entry.effect ?? "include",
        applicationId: entry.applicationId ?? null,
        connectionId: entry.connectionId ?? null,
        catalogEntryId: entry.catalogEntryId ?? null,
        toolName: entry.toolName ?? null,
        riskLevel: entry.riskLevel ?? null,
        conditions: entry.conditions ?? null,
      })),
    );
  }

  async function replaceProfileEntries(
    companyId: string,
    profileId: string,
    entries: CreateToolProfileEntryForProfile[],
    dbClient: ToolAccessMutationDb = db,
  ) {
    await assertProfileEntryInputs(dbClient, companyId, entries);
    await dbClient
      .delete(toolProfileEntries)
      .where(
        and(
          eq(toolProfileEntries.companyId, companyId),
          eq(toolProfileEntries.profileId, profileId),
        ),
      );
    await createProfileEntries(companyId, profileId, entries, dbClient);
  }

  async function assertTargetExists(
    companyId: string,
    targetType: CreateToolProfileBindingForProfile["targetType"],
    targetId: string,
    dbClient: ToolAccessMutationDb = db,
  ) {
    if (targetType === "company") {
      if (targetId !== companyId)
        throw unprocessable(
          "Company profile bindings must target the same company id",
        );
      return;
    }
    if (targetType === "agent") {
      const [row] = await dbClient
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, targetId), eq(agents.companyId, companyId)));
      if (!row)
        throw unprocessable(
          "Tool profile agent binding target must belong to the same company",
        );
      return;
    }
    if (targetType === "project") {
      const [row] = await dbClient
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(eq(projects.id, targetId), eq(projects.companyId, companyId)),
        );
      if (!row)
        throw unprocessable(
          "Tool profile project binding target must belong to the same company",
        );
      return;
    }
    if (targetType === "routine") {
      const [row] = await dbClient
        .select({ id: routines.id })
        .from(routines)
        .where(
          and(eq(routines.id, targetId), eq(routines.companyId, companyId)),
        );
      if (!row)
        throw unprocessable(
          "Tool profile routine binding target must belong to the same company",
        );
      return;
    }
    if (targetType === "issue") {
      const [row] = await dbClient
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, targetId), eq(issues.companyId, companyId)));
      if (!row)
        throw unprocessable(
          "Tool profile issue binding target must belong to the same company",
        );
      return;
    }
    if (targetType === "gateway") {
      const [row] = await dbClient
        .select({ id: toolMcpGateways.id })
        .from(toolMcpGateways)
        .where(
          and(
            eq(toolMcpGateways.id, targetId),
            eq(toolMcpGateways.companyId, companyId),
          ),
        );
      if (!row)
        throw unprocessable(
          "Tool profile gateway binding target must belong to the same company",
        );
    }
  }
  return {
    listProfiles: async (
      companyId: string,
    ): Promise<ToolProfileWithDetails[]> => {
      const profiles = await db
        .select()
        .from(toolProfiles)
        .where(eq(toolProfiles.companyId, companyId))
        .orderBy(desc(toolProfiles.updatedAt));
      if (profiles.length === 0) return [];
      const profileIds = profiles.map((profile) => profile.id);
      const [
        entries,
        bindings,
        catalog,
        companyAgents,
        applications,
        connections,
      ] = await Promise.all([
        db
          .select()
          .from(toolProfileEntries)
          .where(
            and(
              eq(toolProfileEntries.companyId, companyId),
              inArray(toolProfileEntries.profileId, profileIds),
            ),
          )
          .orderBy(asc(toolProfileEntries.createdAt)),
        db
          .select()
          .from(toolProfileBindings)
          .where(
            and(
              eq(toolProfileBindings.companyId, companyId),
              inArray(toolProfileBindings.profileId, profileIds),
            ),
          )
          .orderBy(
            asc(toolProfileBindings.priority),
            asc(toolProfileBindings.createdAt),
          ),
        db
          .select(profileCatalogColumns)
          .from(toolCatalogEntries)
          .where(
            and(
              eq(toolCatalogEntries.companyId, companyId),
              eq(toolCatalogEntries.status, "active"),
            ),
          ),
        db
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.companyId, companyId)),
        db
          .select({ id: toolApplications.id, name: toolApplications.name })
          .from(toolApplications)
          .where(eq(toolApplications.companyId, companyId)),
        db
          .select({ id: toolConnections.id, name: toolConnections.name })
          .from(toolConnections)
          .where(eq(toolConnections.companyId, companyId)),
      ]);
      const entriesByProfile = new Map<
        string,
        Array<typeof toolProfileEntries.$inferSelect>
      >();
      const bindingsByProfile = new Map<
        string,
        Array<typeof toolProfileBindings.$inferSelect>
      >();
      for (const entry of entries) {
        const list = entriesByProfile.get(entry.profileId) ?? [];
        list.push(entry);
        entriesByProfile.set(entry.profileId, list);
      }
      for (const binding of bindings) {
        const list = bindingsByProfile.get(binding.profileId) ?? [];
        list.push(binding);
        bindingsByProfile.set(binding.profileId, list);
      }
      const agentIds = companyAgents.map((agent) => agent.id);
      const applicationsById = new Map(
        applications.map((application) => [application.id, application]),
      );
      const connectionsById = new Map(
        connections.map((connection) => [connection.id, connection]),
      );
      return profiles.map((profile) =>
        buildProfileDetails({
          profile,
          entries: entriesByProfile.get(profile.id) ?? [],
          bindings: bindingsByProfile.get(profile.id) ?? [],
          catalog,
          agentIds,
          applicationsById,
          connectionsById,
        }),
      );
    },

    createProfile: async (
      companyId: string,
      input: CreateToolProfileWithEntries,
    ): Promise<ToolProfileWithDetails> => {
      await assertProfileEntryInputs(db, companyId, input.entries ?? []);
      const [row] = await db
        .insert(toolProfiles)
        .values({
          companyId,
          profileKey: input.profileKey,
          name: input.name,
          description: input.description ?? null,
          status: input.status ?? "active",
          defaultAction: input.defaultAction ?? "deny",
          metadata: input.metadata ?? {},
        })
        .returning();
      await createProfileEntries(companyId, row.id, input.entries ?? []);
      return profileDetails(row.id, companyId);
    },

    getProfile: profileDetails,

    listProfileNewTools,

    reviewProfileNewTools,

    updateProfile: async (
      profileId: string,
      input: UpdateToolProfileWithEntries,
    ): Promise<ToolProfileWithDetails> => {
      const existing = await getProfileRow(profileId);
      if (input.entries) {
        await assertProfileEntryInputs(db, existing.companyId, input.entries);
      }
      const referencesChanged = new Error("Tool profile references changed");
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await db.transaction(async tx => {
            const db = tx as unknown as Db;
            const readReferences = () => tx.select({ applicationId: toolProfileEntries.applicationId, connectionId: toolProfileEntries.connectionId, catalogEntryId: toolProfileEntries.catalogEntryId })
              .from(toolProfileEntries).where(and(eq(toolProfileEntries.companyId, existing.companyId), eq(toolProfileEntries.profileId, profileId)))
              .orderBy(toolProfileEntries.id);
            const oldReferences = input.entries ? await readReferences() : [];
            await lockProfileEntryReferences(tx, existing.companyId, [...oldReferences, ...(input.entries ?? [])]);
            const [current] = await tx.select().from(toolProfiles).where(eq(toolProfiles.id, profileId)).for("no key update");
            if (!current) throw notFound("Tool profile not found");
            if (input.entries && JSON.stringify(await readReferences()) !== JSON.stringify(oldReferences)) throw referencesChanged;
            await db
              .update(toolProfiles)
              .set({
                profileKey: input.profileKey ?? current.profileKey,
                name: input.name ?? current.name,
                description: input.description ?? current.description,
                status: input.status ?? current.status,
                defaultAction: input.defaultAction ?? current.defaultAction,
                metadata: input.metadata ?? current.metadata,
                updatedAt: new Date(),
              })
              .where(eq(toolProfiles.id, profileId));
            if (input.entries) {
              await replaceProfileEntries(
                existing.companyId,
                profileId,
                input.entries,
                tx,
              );
            }
          });
          break;
        } catch (error) {
          if (error !== referencesChanged) throw error;
          if (attempt >= 2) throw conflict("Tool profile entries changed during replacement", { retryable: true });
        }
      }
      return profileDetails(profileId, existing.companyId);
    },

    duplicateProfile: async (
      profileId: string,
      input: DuplicateToolProfile,
    ): Promise<ToolProfileWithDetails> => {
      const existing = await getProfileRow(profileId);
      const [entries, bindings] = await Promise.all([
        db
          .select()
          .from(toolProfileEntries)
          .where(
            and(
              eq(toolProfileEntries.companyId, existing.companyId),
              eq(toolProfileEntries.profileId, existing.id),
            ),
          )
          .orderBy(asc(toolProfileEntries.createdAt)),
        db
          .select()
          .from(toolProfileBindings)
          .where(
            and(
              eq(toolProfileBindings.companyId, existing.companyId),
              eq(toolProfileBindings.profileId, existing.id),
            ),
          )
          .orderBy(
            asc(toolProfileBindings.priority),
            asc(toolProfileBindings.createdAt),
          ),
      ]);
      const [created] = await db
        .insert(toolProfiles)
        .values({
          companyId: existing.companyId,
          profileKey: normalizeKey(`${input.name}-${randomUUID().slice(0, 8)}`),
          name: input.name,
          description: existing.description,
          status: "active",
          defaultAction: existing.defaultAction,
          newToolsReviewedAt: existing.newToolsReviewedAt,
          metadata: existing.metadata ?? {},
        })
        .returning();
      if (entries.length > 0) {
        await db.insert(toolProfileEntries).values(
          entries.map((entry) => ({
            companyId: entry.companyId,
            profileId: created.id,
            selectorType: entry.selectorType,
            effect: entry.effect,
            applicationId: entry.applicationId,
            connectionId: entry.connectionId,
            catalogEntryId: entry.catalogEntryId,
            toolName: entry.toolName,
            riskLevel: entry.riskLevel,
            conditions: entry.conditions,
          })),
        );
      }
      if (input.includeAssignments && bindings.length > 0) {
        await db.insert(toolProfileBindings).values(
          bindings.map((binding) => ({
            companyId: binding.companyId,
            profileId: created.id,
            targetType: binding.targetType,
            targetId: binding.targetId,
            priority: binding.priority,
            metadata: binding.metadata ?? {},
            createdByAgentId: binding.createdByAgentId,
            createdByUserId: binding.createdByUserId,
          })),
        );
      }
      return profileDetails(created.id, existing.companyId);
    },

    deleteProfile: async (
      profileId: string,
      input: DeleteToolProfile,
    ): Promise<{
      profile: ToolProfile;
      summary: ToolProfileSummary;
      reassignedToProfileId: string | null;
      reassignedBindingCount: number;
    }> => db.transaction(async tx => {
      const existing = await getProfileRow(profileId, undefined, tx);
      const db = tx as unknown as Db;
      await tx.select({ id: toolProfiles.id }).from(toolProfiles)
        .where(and(eq(toolProfiles.companyId, existing.companyId), inArray(toolProfiles.id, [profileId, ...(input.reassignToProfileId ? [input.reassignToProfileId] : [])])))
        .orderBy(toolProfiles.id).for("update");
      await lockToolAssignmentAgents(tx, existing.companyId, [{ targetType: "company", targetId: existing.companyId }]);
      if (input.force && input.reassignToProfileId) {
        throw badRequest(
          "Use either force or reassignToProfileId when deleting a tool profile, not both",
        );
      }
      const details = await profileDetails(existing.id, existing.companyId, tx);
      if (
        details.summary.isCompanyDefault &&
        !input.force &&
        !input.reassignToProfileId
      ) {
        throw unprocessable(
          "Cannot delete the company default tool profile. Reassign the default profile or pass force=true to delete it.",
          { summary: details.summary },
        );
      }

      let reassignedBindingCount = 0;
      if (input.reassignToProfileId) {
        if (input.reassignToProfileId === existing.id) {
          throw badRequest(
            "reassignToProfileId must reference a different tool profile",
          );
        }
        const target = await getProfileRow(
          input.reassignToProfileId,
          existing.companyId,
          tx,
        );
        if (target.status !== "active") {
          throw unprocessable(
            "Tool profile assignments can only be reassigned to an active profile",
          );
        }
        const targetBindings = await db
          .select()
          .from(toolProfileBindings)
          .where(
            and(
              eq(toolProfileBindings.companyId, existing.companyId),
              eq(toolProfileBindings.profileId, target.id),
            ),
          );
        const targetKeys = new Set(
          targetBindings.map(
            (binding) => `${binding.targetType}:${binding.targetId}`,
          ),
        );
        const copiedBindings = details.bindings.filter(
          (binding) =>
            !targetKeys.has(`${binding.targetType}:${binding.targetId}`),
        );
        if (copiedBindings.length > 0) {
          await db.insert(toolProfileBindings).values(
            copiedBindings.map((binding) => ({
              companyId: binding.companyId,
              profileId: target.id,
              targetType: binding.targetType,
              targetId: binding.targetId,
              priority: binding.priority,
              metadata: binding.metadata ?? {},
              createdByAgentId: binding.createdByAgentId,
              createdByUserId: binding.createdByUserId,
            })),
          );
          reassignedBindingCount = copiedBindings.length;
          await db
            .update(toolProfiles)
            .set({ updatedAt: new Date() })
            .where(eq(toolProfiles.id, target.id));
        }
      }

      const [deleted] = await db
        .delete(toolProfiles)
        .where(eq(toolProfiles.id, existing.id))
        .returning();
      if (!deleted) throw notFound("Tool profile not found");
      return {
        profile: toProfile(deleted),
        summary: details.summary,
        reassignedToProfileId: input.reassignToProfileId ?? null,
        reassignedBindingCount,
      };
    }),

    addProfileEntry: async (
      profileId: string,
      input: CreateToolProfileEntryForProfile,
    ): Promise<ToolProfileEntry> => db.transaction(async tx => {
      const db = tx as unknown as Db;
      const profile = await getProfileRow(profileId, undefined, tx);
      await assertProfileEntryInputs(tx, profile.companyId, [input]);
      await lockProfileEntryReferences(tx, profile.companyId, [input]);
      await tx.select({ id: toolProfiles.id }).from(toolProfiles).where(eq(toolProfiles.id, profile.id)).for("no key update");
      const [row] = await db
        .insert(toolProfileEntries)
        .values({
          companyId: profile.companyId,
          profileId: profile.id,
          selectorType: input.selectorType,
          effect: input.effect ?? "include",
          applicationId: input.applicationId ?? null,
          connectionId: input.connectionId ?? null,
          catalogEntryId: input.catalogEntryId ?? null,
          toolName: input.toolName ?? null,
          riskLevel: input.riskLevel ?? null,
          conditions: input.conditions ?? null,
        })
        .returning();
      await db
        .update(toolProfiles)
        .set({ updatedAt: new Date() })
        .where(eq(toolProfiles.id, profile.id));
      return toProfileEntry(row);
    }),

    getProfileEntry: async (entryId: string): Promise<ToolProfileEntry> => {
      const [row] = await db
        .select()
        .from(toolProfileEntries)
        .where(eq(toolProfileEntries.id, entryId));
      if (!row) throw notFound("Tool profile entry not found");
      return toProfileEntry(row);
    },

    updateProfileEntry: async (
      entryId: string,
      input: UpdateToolProfileEntry,
    ): Promise<ToolProfileEntry> => db.transaction(async tx => {
      const db = tx as unknown as Db;
      const [existing] = await db
        .select()
        .from(toolProfileEntries)
        .where(eq(toolProfileEntries.id, entryId));
      if (!existing) throw notFound("Tool profile entry not found");
      const next: CreateToolProfileEntryForProfile = {
        selectorType: input.selectorType ?? existing.selectorType,
        effect: input.effect ?? existing.effect,
        applicationId: input.applicationId ?? existing.applicationId,
        connectionId: input.connectionId ?? existing.connectionId,
        catalogEntryId: input.catalogEntryId ?? existing.catalogEntryId,
        toolName: input.toolName ?? existing.toolName,
        riskLevel: input.riskLevel ?? existing.riskLevel,
        conditions: input.conditions ?? existing.conditions,
      };
      await assertProfileEntryInputs(tx, existing.companyId, [next]);
      await lockProfileEntryReferences(tx, existing.companyId, [next]);
      await tx.select({ id: toolProfiles.id }).from(toolProfiles).where(eq(toolProfiles.id, existing.profileId)).for("no key update");
      const [row] = await db
        .update(toolProfileEntries)
        .set({
          selectorType: next.selectorType,
          effect: next.effect ?? "include",
          applicationId: next.applicationId ?? null,
          connectionId: next.connectionId ?? null,
          catalogEntryId: next.catalogEntryId ?? null,
          toolName: next.toolName ?? null,
          riskLevel: next.riskLevel ?? null,
          conditions: next.conditions ?? null,
          updatedAt: new Date(),
        })
        .where(eq(toolProfileEntries.id, entryId))
        .returning();
      await db
        .update(toolProfiles)
        .set({ updatedAt: new Date() })
        .where(eq(toolProfiles.id, existing.profileId));
      return toProfileEntry(row);
    }),

    deleteProfileEntry: async (entryId: string): Promise<ToolProfileEntry> => db.transaction(async tx => {
      const db = tx as unknown as Db;
      const [existing] = await tx.select().from(toolProfileEntries).where(eq(toolProfileEntries.id, entryId));
      if (!existing) throw notFound("Tool profile entry not found");
      await tx.select({ id: toolProfiles.id }).from(toolProfiles).where(eq(toolProfiles.id, existing.profileId)).for("no key update");
      const [row] = await db
        .delete(toolProfileEntries)
        .where(eq(toolProfileEntries.id, entryId))
        .returning();
      if (!row) throw notFound("Tool profile entry not found");
      await db
        .update(toolProfiles)
        .set({ updatedAt: new Date() })
        .where(eq(toolProfiles.id, row.profileId));
      return toProfileEntry(row);
    }),

    bindProfile: async (
      profileId: string,
      input: CreateToolProfileBindingForProfile,
      actor?: ActorInfo,
    ): Promise<ToolProfileBinding> => db.transaction(async tx => {
      const db = tx as unknown as Db;
      const [profile] = await tx.select().from(toolProfiles).where(eq(toolProfiles.id, profileId)).for("no key update");
      if (!profile) throw notFound("Tool profile not found");
      await assertTargetExists(
        profile.companyId,
        input.targetType,
        input.targetId,
        tx,
      );
      const [row] = await db
        .insert(toolProfileBindings)
        .values({
          companyId: profile.companyId,
          profileId: profile.id,
          targetType: input.targetType,
          targetId: input.targetId,
          priority: input.priority ?? 100,
          metadata: input.metadata ?? {},
          createdByAgentId:
            actor?.actorType === "agent" ? (actor.actorId ?? null) : null,
          createdByUserId:
            actor?.actorType === "user" ? (actor.actorId ?? null) : null,
        })
        .returning();
      await db
        .update(toolProfiles)
        .set({ updatedAt: new Date() })
        .where(eq(toolProfiles.id, profile.id));
      return toProfileBinding(row);
    }),

    unbindProfile: async (
      profileId: string,
      input: UnbindToolProfileBinding,
    ): Promise<{ unbound: number }> => db.transaction(async tx => {
      const db = tx as unknown as Db;
      const [profile] = await tx.select().from(toolProfiles).where(eq(toolProfiles.id, profileId)).for("no key update");
      if (!profile) throw notFound("Tool profile not found");
      await assertTargetExists(
        profile.companyId,
        input.targetType,
        input.targetId,
        tx,
      );
      const rows = await db
        .delete(toolProfileBindings)
        .where(
          and(
            eq(toolProfileBindings.companyId, profile.companyId),
            eq(toolProfileBindings.profileId, profile.id),
            eq(toolProfileBindings.targetType, input.targetType),
            eq(toolProfileBindings.targetId, input.targetId),
          ),
        )
        .returning({ id: toolProfileBindings.id });
      if (rows.length > 0) {
        await db
          .update(toolProfiles)
          .set({ updatedAt: new Date() })
          .where(eq(toolProfiles.id, profile.id));
      }
      return { unbound: rows.length };
    })
  };
}
