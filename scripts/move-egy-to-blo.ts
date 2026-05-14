import { createDb } from "../packages/db/src/index.js";
import { secretService } from "../server/src/services/secrets.js";
import { loadConfig } from "../server/src/config.js";

const COMPANY_ID = "aaced805-3491-4ee5-9b14-cdf70cb81d47";
const EGY_TEAM_ID = "cbd565bc-c487-40a2-a463-e35eaa24461e";
const BLO_TEAM_ID = "0241f28e-e546-48d9-a1a2-c1655adf9ba4";
const LINEAR_API = "https://api.linear.app/graphql";

async function gql<T>(token: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  if (!json.data) throw new Error("No data returned");
  return json.data;
}

async function main() {
  const config = loadConfig();
  const dbUrl = config.databaseUrl ?? "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
  const db = createDb(dbUrl);
  const svc = secretService(db as any);

  // 1. Resolve Linear OAuth token
  const secret = await svc.getByName(COMPANY_ID, "linear-oauth-token");
  if (!secret) throw new Error("No linear-oauth-token secret for company");
  const token = await svc.resolveSecretValue(COMPANY_ID, secret.id, "latest");
  if (!token) throw new Error("Failed to resolve token");

  // 2. Get viewer (the authenticated user)
  const viewer = await gql<{ viewer: { id: string; name: string; email: string } }>(
    token,
    "query { viewer { id name email } }",
  );
  console.log(`Linear viewer: ${viewer.viewer.name} <${viewer.viewer.email}> id=${viewer.viewer.id}`);

  // 3. List all EGY-team issues created by viewer
  const all: Array<{ id: string; identifier: string; title: string }> = [];
  let cursor: string | undefined;
  while (true) {
    const page = await gql<{
      issues: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{ id: string; identifier: string; title: string }>;
      };
    }>(
      token,
      `query($teamId: ID!, $creatorId: ID!, $after: String) {
        issues(
          filter: { team: { id: { eq: $teamId } }, creator: { id: { eq: $creatorId } } }
          first: 100
          after: $after
        ) {
          pageInfo { hasNextPage endCursor }
          nodes { id identifier title }
        }
      }`,
      { teamId: EGY_TEAM_ID, creatorId: viewer.viewer.id, after: cursor ?? null },
    );
    all.push(...page.issues.nodes);
    if (!page.issues.pageInfo.hasNextPage) break;
    cursor = page.issues.pageInfo.endCursor ?? undefined;
  }

  console.log(`\nFound ${all.length} EGY-team issue(s) created by ${viewer.viewer.name}:`);
  for (const i of all) console.log(`  ${i.identifier}  ${i.title.slice(0, 60)}`);

  if (process.argv.includes("--apply")) {
    console.log(`\nMoving ${all.length} issue(s) to BLO team...`);
    let moved = 0;
    let failed = 0;
    for (const i of all) {
      try {
        const res = await gql<{ issueUpdate: { success: boolean; issue: { identifier: string } } }>(
          token,
          `mutation($id: String!, $teamId: String!) {
            issueUpdate(id: $id, input: { teamId: $teamId }) {
              success
              issue { identifier }
            }
          }`,
          { id: i.id, teamId: BLO_TEAM_ID },
        );
        if (res.issueUpdate.success) {
          console.log(`  ✓ ${i.identifier} → ${res.issueUpdate.issue.identifier}`);
          moved++;
        } else {
          console.log(`  ✗ ${i.identifier}: update returned success=false`);
          failed++;
        }
      } catch (e) {
        console.log(`  ✗ ${i.identifier}: ${(e as Error).message}`);
        failed++;
      }
    }
    console.log(`\nDone: ${moved} moved, ${failed} failed`);
  } else {
    console.log(`\n(dry run — pass --apply to actually move them)`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
