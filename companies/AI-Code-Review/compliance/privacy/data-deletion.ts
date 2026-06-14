import { db } from "../../packages/db"

interface DeletionRequest {
  orgId: string
  requestedBy: string
  reason?: string
}

export async function scheduleOrgDeletion(request: DeletionRequest): Promise<void> {
  // Validate the requesting user has admin role
  // Create deletion job in queue
  // Send confirmation email to org admins
  // Return deletion request ID

  await db.query(
    `INSERT INTO data_deletion_requests (org_id, requested_by, reason, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (org_id) WHERE status = 'pending' DO NOTHING`,
    [request.orgId, request.requestedBy, request.reason],
  )
}

export async function executeOrgDeletion(orgId: string): Promise<void> {
  const client = await db.connect()

  try {
    await client.query("BEGIN")

    // Anonymize user PII
    await client.query(
      `UPDATE users SET
         email = 'deleted-' || id || '@deleted.codereview.ai',
         name = 'Deleted User',
         avatar_url = NULL,
         deleted_at = now()
       WHERE org_id = $1`,
      [orgId],
    )

    // Delete API keys
    await client.query("DELETE FROM api_keys WHERE org_id = $1", [orgId])

    // Anonymize review data (retain for billing/audit but remove PII)
    await client.query(
      `UPDATE review_results SET
         raw_diff = NULL,
         deleted_at = now()
       WHERE org_id = $1`,
      [orgId],
    )

    // Write audit entry
    await client.query(
      `SELECT audit.write_entry(
         $1::UUID, 'system', $2::UUID, 'org_data_deleted',
         'organization', $2::TEXT
       )`,
      [orgId, orgId],
    )

    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function exportOrgData(orgId: string): Promise<object> {
  const [users, repos, reviews] = await Promise.all([
    db.query("SELECT id, email, name, role, created_at FROM users WHERE org_id = $1", [orgId]),
    db.query("SELECT id, name, provider, provider_repo_id, created_at FROM repositories WHERE org_id = $1", [orgId]),
    db.query("SELECT id, pr_number, status, created_at, summary FROM review_results WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1000", [orgId]),
  ])

  return {
    exported_at: new Date().toISOString(),
    org_id: orgId,
    users: users.rows,
    repositories: repos.rows,
    recent_reviews: reviews.rows,
  }
}
