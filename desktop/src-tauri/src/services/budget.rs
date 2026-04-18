use sqlx::SqlitePool;
use uuid::Uuid;
use crate::events;

pub async fn check_and_reset_monthly_budgets(pool: &SqlitePool) -> Result<(), String> {
    // Get current UTC month
    let current_month: String = sqlx::query_scalar::<_, String>("SELECT strftime('%Y-%m', 'now')")
        .fetch_one(pool).await.map_err(|e| e.to_string())?;

    // Check stored last reset month
    let last_reset = sqlx::query_scalar::<_, Option<String>>(
        "SELECT value FROM settings WHERE key = 'last_budget_reset_month'"
    ).fetch_optional(pool).await.map_err(|e| e.to_string())?.flatten();

    if last_reset.as_deref() != Some(&current_month) {
        // Reset all agents' monthly spend
        sqlx::query("UPDATE agents SET spent_monthly_cents = 0 WHERE spent_monthly_cents > 0")
            .execute(pool).await.map_err(|e| e.to_string())?;

        // Record the reset
        sqlx::query(
            "INSERT INTO settings (key, value) VALUES ('last_budget_reset_month', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
        ).bind(&current_month).execute(pool).await.map_err(|e| e.to_string())?;

        eprintln!("[budget] Monthly budget reset for {}", current_month);
    }

    Ok(())
}

pub async fn enforce_budget_policies(
    pool: &SqlitePool,
    app: &tauri::AppHandle,
    company_id: &str,
    agent_id: &str,
    new_cost_cents: i64,
) -> Result<bool, String> {
    // Check if any budget policy is exceeded
    let policies = sqlx::query_as::<_, (String, i64, i32, bool)>(
        "SELECT id, amount, warn_percent, hard_stop_enabled FROM budget_policies WHERE company_id = ? AND is_active = 1 AND (scope_type = 'company' OR (scope_type = 'agent' AND scope_id = ?))"
    ).bind(company_id).bind(agent_id).fetch_all(pool).await.map_err(|e| e.to_string())?;

    let agent_spent: i64 = sqlx::query_scalar(
        "SELECT COALESCE(spent_monthly_cents, 0) FROM agents WHERE id = ?"
    ).bind(agent_id).fetch_one(pool).await.map_err(|e| e.to_string())?;

    let total_spent = agent_spent + new_cost_cents;
    let mut should_pause = false;

    for (policy_id, amount, warn_pct, hard_stop) in &policies {
        if *amount <= 0 { continue; }
        let pct_used = (total_spent as f64 / *amount as f64 * 100.0) as i32;

        if pct_used >= *warn_pct {
            events::emit(app, events::AppEvent::AgentUpdated { agent_id: agent_id.to_string() });
        }

        if *hard_stop && total_spent >= *amount {
            should_pause = true;
            // Create budget incident
            let incident_id = Uuid::new_v4().to_string();
            let _ = sqlx::query(
                "INSERT INTO budget_incidents (id, company_id, policy_id, scope_type, scope_id, metric, window_kind, amount_limit, amount_observed, status) VALUES (?, ?, ?, 'agent', ?, 'billed_cents', 'monthly', ?, ?, 'open')"
            ).bind(&incident_id).bind(company_id).bind(policy_id).bind(agent_id).bind(amount).bind(total_spent)
                .execute(pool).await;
        }
    }

    if should_pause {
        sqlx::query("UPDATE agents SET status='paused', pause_reason='budget', paused_at=datetime('now') WHERE id=? AND status != 'paused'")
            .bind(agent_id).execute(pool).await.map_err(|e| e.to_string())?;
    }

    Ok(should_pause)
}
