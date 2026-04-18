use sqlx::SqlitePool;
use uuid::Uuid;

const RESET_WAKE_REASONS: &[&str] = &[
    "issue_assigned", "review_requested", "issue_reopened",
    "execution_review_requested", "execution_approval_requested",
];

pub fn derive_task_key(issue_id: Option<&str>, source: &str) -> String {
    match issue_id {
        Some(id) if !id.is_empty() => format!("issue:{}", id),
        _ if source == "scheduler" || source == "timer" => "heartbeat".to_string(),
        _ => "default".to_string(),
    }
}

pub fn should_reset_session(wake_reason: Option<&str>) -> bool {
    match wake_reason {
        Some(reason) => RESET_WAKE_REASONS.iter().any(|r| *r == reason),
        None => false,
    }
}

pub async fn resolve_session_for_task(
    pool: &SqlitePool,
    company_id: &str,
    agent_id: &str,
    adapter_type: &str,
    task_key: &str,
    wake_reason: Option<&str>,
) -> Option<String> {
    // If wake reason requires reset, delete the task session
    if should_reset_session(wake_reason) {
        let _ = sqlx::query(
            "DELETE FROM agent_task_sessions WHERE company_id=? AND agent_id=? AND adapter_type=? AND task_key=?"
        ).bind(company_id).bind(agent_id).bind(adapter_type).bind(task_key)
            .execute(pool).await;
        return None;
    }

    // Look up existing session
    let result = sqlx::query_as::<_, (String, i64, i64)>(
        "SELECT session_params_json, total_runs, total_input_tokens FROM agent_task_sessions WHERE company_id=? AND agent_id=? AND adapter_type=? AND task_key=?"
    ).bind(company_id).bind(agent_id).bind(adapter_type).bind(task_key)
        .fetch_optional(pool).await.ok()?;

    match result {
        Some((params_json, total_runs, total_tokens)) => {
            // Check compaction thresholds
            if total_runs > 200 || total_tokens > 2_000_000 {
                // Session exceeded thresholds, rotate
                let _ = sqlx::query(
                    "DELETE FROM agent_task_sessions WHERE company_id=? AND agent_id=? AND adapter_type=? AND task_key=?"
                ).bind(company_id).bind(agent_id).bind(adapter_type).bind(task_key)
                    .execute(pool).await;
                return None;
            }

            // Extract session_id from params JSON
            let params: serde_json::Value = serde_json::from_str(&params_json).unwrap_or_default();
            params.get("sessionId").or(params.get("session_id"))
                .and_then(|v| v.as_str())
                .map(String::from)
        }
        None => None,
    }
}

pub async fn record_session_for_task(
    pool: &SqlitePool,
    company_id: &str,
    agent_id: &str,
    adapter_type: &str,
    task_key: &str,
    session_id: &str,
    run_id: &str,
    input_tokens: i64,
) -> Result<(), String> {
    let id = Uuid::new_v4().to_string();
    let params_json = serde_json::json!({"sessionId": session_id}).to_string();

    sqlx::query(
        "INSERT INTO agent_task_sessions (id, company_id, agent_id, adapter_type, task_key, session_params_json, session_display_id, last_run_id, total_runs, total_input_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(company_id, agent_id, adapter_type, task_key) DO UPDATE SET
         session_params_json=excluded.session_params_json, session_display_id=excluded.session_display_id,
         last_run_id=excluded.last_run_id,
         total_runs=agent_task_sessions.total_runs + 1,
         total_input_tokens=agent_task_sessions.total_input_tokens + excluded.total_input_tokens,
         updated_at=datetime('now')"
    )
    .bind(&id).bind(company_id).bind(agent_id).bind(adapter_type).bind(task_key)
    .bind(&params_json).bind(session_id).bind(run_id).bind(input_tokens)
    .execute(pool).await.map_err(|e| e.to_string())?;

    Ok(())
}
