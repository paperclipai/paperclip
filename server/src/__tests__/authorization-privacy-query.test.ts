import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, companies, companyMemberships, createDb, issueAccessGrants, issues, projectAccessMembers, projects, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canActorReadIssuePrivacy, issueReadSqlCondition, type AuthorizationActor } from "../services/authorization.js";
import { issueService } from "../services/issues.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { recursiveIssueWork, seedPrivacyFixture } from "./helpers/privacy-query-fixture.js";

describe("privacy ancestry query work", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("privacy-query-"); db = createDb(database.connectionString); }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it("does not rescan company tasks when resolving absent privacy parents", async () => {
    const f = await seedPrivacyFixture(db, { name: "open roots", count: 1200, participated: 0, history: 0, comments: 0 });
    const condition = await issueReadSqlCondition(db, { type: "board", userId: f.userId, authorizingUserId: f.userId });
    const query = db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, f.companyId), condition)).orderBy(issues.id);
    expect((await query).map(row => row.id)).toEqual([...f.ids].sort());
    const statement = query.toSQL();
    await db.execute(sql`set jit=off`);
    const [explain] = await db.$client.unsafe(`explain (analyze,buffers,format json) ${statement.sql}`, statement.params as never[]);
    const work = recursiveIssueWork(explain["QUERY PLAN"][0].Plan);
    expect(work.recursiveNodes).toBeGreaterThan(0);
    expect(work.inspectedRows).toBeLessThanOrEqual(f.ids.length * 3);
    expect(work.projectProbes).toBeLessThanOrEqual(f.ids.length * 3);
  });
  it("retains grant direction, private-only traversal, cycles and tenant boundaries", async () => {
    const companyId = randomUUID(), otherCompany = randomUUID(), userId = randomUUID();
    await db.insert(companies).values([companyId, otherCompany].map(id => ({ id, name: "Privacy graph", issuePrefix: `P${id.slice(0,7)}` })));
    const ids = Object.fromEntries(["root", "child", "grandchild", "sibling", "barrier", "behindBarrier", "cycleA", "cycleB", "foreign", "foreignChild"].map(name => [name, randomUUID()]));
    await db.insert(issues).values(Object.entries(ids).map(([name,id]) => ({ id, companyId: name === "foreign" ? otherCompany : companyId, title: name, visibility: name === "barrier" ? "open" : "private", createdByUserId: "other-user" })));
    const parents = { child: "root", grandchild: "child", sibling: "root", barrier: "root", behindBarrier: "barrier", cycleA: "cycleB", cycleB: "cycleA", foreignChild: "foreign" };
    for (const [child,parent] of Object.entries(parents)) await db.update(issues).set({ privacyParentIssueId: ids[parent]! }).where(eq(issues.id,ids[child]!));
    const privacyRows = new Map((await db.select().from(issues).where(eq(issues.companyId, companyId))).map(row => [row.id, row]));
    const actor: AuthorizationActor = { type: "board", userId, authorizingUserId: userId };
    const [grant] = await db.insert(issueAccessGrants).values({ issueId: ids.child!, subjectType: "user", subjectId: userId, source: "explicit" }).returning();
    const condition = await issueReadSqlCondition(db, actor);
    const read = async () => (await db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId,companyId),condition))).map(row=>row.id).sort();
    expect(await read()).toEqual([ids.child!,ids.grandchild!].sort());
    await db.update(issueAccessGrants).set({ revokedAt:new Date() }).where(eq(issueAccessGrants.id,grant!.id));
    expect(await read()).toEqual([]);
    await db.insert(issueAccessGrants).values([ids.root!,ids.cycleB!,ids.foreign!].map(issueId=>({ issueId, subjectType:"user", subjectId:userId, source:"explicit" })));
    expect(await read()).toEqual([ids.root!,ids.child!,ids.grandchild!,ids.sibling!,ids.barrier!,ids.cycleA!,ids.cycleB!].sort());
    for (const [name,expected] of [["cycleA",true],["cycleB",true],["behindBarrier",false],["foreignChild",false]] as const) {
      expect(await canActorReadIssuePrivacy(db,actor,privacyRows.get(ids[name]!)!)).toBe(expected);
    }
    await db.update(issueAccessGrants).set({ revokedAt:new Date() }).where(eq(issueAccessGrants.issueId,ids.cycleB!));
    expect(await canActorReadIssuePrivacy(db,actor,privacyRows.get(ids.cycleA!)!)).toBe(false);
  });

  it("intersects current agent, responsible-user and authorizing-user grants through ancestors", async () => {
    const companyId=randomUUID(), owner=randomUUID(), authorizer=randomUUID();
    await db.insert(companies).values({id:companyId,name:"Agent privacy",issuePrefix:`P${companyId.slice(0,7)}`});
    await db.insert(companyMemberships).values([owner,authorizer].map(principalId=>({companyId,principalType:"user",principalId,status:"active",membershipRole:"operator"})));
    const [agent]=await db.insert(agents).values({companyId,name:"Shared agent",adapterType:"process"}).returning();
    const [parent]=await db.insert(issues).values({companyId,title:"Ancestor",visibility:"private",createdByUserId:"someone-else"}).returning();
    const [child]=await db.insert(issues).values({companyId,title:"Descendant",visibility:"private",privacyParentIssueId:parent!.id,createdByUserId:"someone-else"}).returning();
    const actor:AuthorizationActor={type:"agent",agentId:agent!.id,onBehalfOfUserId:owner,authorizingUserId:authorizer};
    const readable=()=>canActorReadIssuePrivacy(db,actor,child!);
    await db.insert(issueAccessGrants).values({issueId:parent!.id,subjectType:"agent",subjectId:agent!.id,source:"explicit"});
    expect(await readable()).toBe(false);
    await db.insert(issueAccessGrants).values({issueId:parent!.id,subjectType:"user",subjectId:owner,source:"explicit"});
    expect(await readable()).toBe(false);
    const [grant]=await db.insert(issueAccessGrants).values({issueId:parent!.id,subjectType:"user",subjectId:authorizer,source:"explicit"}).returning();
    expect(await readable()).toBe(true);
    const condition=await issueReadSqlCondition(db,actor);
    expect((await db.select({id:issues.id}).from(issues).where(and(eq(issues.id,child!.id),condition))).length).toBe(1);
    await db.update(issueAccessGrants).set({revokedAt:new Date()}).where(eq(issueAccessGrants.id,grant!.id));
    expect(await readable()).toBe(false);
    expect(await db.select({id:issues.id}).from(issues).where(and(eq(issues.id,child!.id),condition))).toEqual([]);
    await db.update(issueAccessGrants).set({revokedAt:null}).where(eq(issueAccessGrants.id,grant!.id));
    await db.update(companyMemberships).set({status:"archived"}).where(and(eq(companyMemberships.companyId,companyId),eq(companyMemberships.principalId,owner)));
    expect(await readable()).toBe(false);
  });

  it("applies fresh inherited project membership before list pagination", async () => {
    const f=await seedPrivacyFixture(db,{name:"paged",count:130,participated:130,history:1,comments:1});
    await db.update(issues).set({createdByUserId:"other-human",visibility:"private"}).where(eq(issues.companyId,f.companyId));
    const [project]=await db.insert(projects).values({companyId:f.companyId,name:"Private project",visibility:"private"}).returning();
    const ordered=[...f.ids].sort(), allowed=ordered.slice(100);
    await db.update(issues).set({projectId:project!.id}).where(inArray(issues.id,allowed));
    const actor:AuthorizationActor={type:"board",userId:f.userId,authorizingUserId:f.userId};
    const condition=await issueReadSqlCondition(db,actor), svc=issueService(db);
    const read=()=>svc.list(f.companyId,{readCondition:condition,limit:20,sortField:"id",sortDir:"asc",touchedByUserId:f.userId});
    expect(await read()).toEqual([]);
    const [member]=await db.insert(projectAccessMembers).values({companyId:f.companyId,projectId:project!.id,subjectType:"user",subjectId:f.userId}).returning();
    expect((await read()).map(row=>row.id)).toEqual(allowed.slice(0,20));
    expect((await svc.unreadInboxIssueIds(f.companyId,f.userId,condition)).sort()).toEqual(allowed);
    await db.delete(projectAccessMembers).where(eq(projectAccessMembers.id,member!.id));
    expect(await read()).toEqual([]);
    expect(await svc.unreadInboxIssueIds(f.companyId,f.userId,condition)).toEqual([]);
  });

  it("traverses a complete deep private chain with a root-only grant and revokes it fresh", async () => {
    const f=await seedPrivacyFixture(db,{name:"deep",count:64,participated:0,history:0,comments:0,graph:"deep"});
    const actor:AuthorizationActor={type:"board",userId:f.userId,authorizingUserId:f.userId};
    const condition=await issueReadSqlCondition(db,actor);
    const query=()=>db.select({id:issues.id}).from(issues).where(and(eq(issues.companyId,f.companyId),condition)).orderBy(issues.id);
    expect((await query()).map(row=>row.id)).toEqual([...f.ids].sort());
    await db.update(issueAccessGrants).set({revokedAt:new Date()}).where(eq(issueAccessGrants.issueId,f.ids[0]!));
    expect(await query()).toEqual([]);
  });

  it("follows an open ancestor in a private project and rechecks its restriction and inherited grant", async () => {
    const companyId = randomUUID(), userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Project ancestor", issuePrefix: `P${companyId.slice(0, 7)}` });
    const [project] = await db.insert(projects).values({ companyId, name: "Private ancestor project", visibility: "private" }).returning();
    const [grandparent] = await db.insert(issues).values({ companyId, title: "Granted grandparent", visibility: "private", createdByUserId: "other-user" }).returning();
    const [parent] = await db.insert(issues).values({ companyId, title: "Open parent in private project", visibility: "open", projectId: project!.id, privacyParentIssueId: grandparent!.id, createdByUserId: "other-user" }).returning();
    const [child] = await db.insert(issues).values({ companyId, title: "Private child", visibility: "private", privacyParentIssueId: parent!.id, createdByUserId: "other-user" }).returning();
    const actor: AuthorizationActor = { type: "board", userId, authorizingUserId: userId };
    const condition = await issueReadSqlCondition(db, actor);
    const read = async () => (await db.select({ id: issues.id }).from(issues).where(and(eq(issues.id, child!.id), condition))).map(row => row.id);
    expect(await canActorReadIssuePrivacy(db, actor, child!)).toBe(false);
    const [grant] = await db.insert(issueAccessGrants).values({ issueId: grandparent!.id, subjectType: "user", subjectId: userId, source: "explicit" }).returning();
    expect(await read()).toEqual([child!.id]);
    expect(await canActorReadIssuePrivacy(db, actor, child!)).toBe(true);
    await db.update(projects).set({ visibility: "open" }).where(eq(projects.id, project!.id));
    expect(await read()).toEqual([]);
    await db.update(projects).set({ visibility: "private" }).where(eq(projects.id, project!.id));
    expect(await read()).toEqual([child!.id]);
    await db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.id, grant!.id));
    expect(await read()).toEqual([]);
    expect(await canActorReadIssuePrivacy(db, actor, child!)).toBe(false);
  });

});
