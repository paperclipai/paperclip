use crate::events::{self, AppEvent};
use sqlx::SqlitePool;
use tauri::AppHandle;

pub async fn start_scheduler(app: AppHandle, pool: SqlitePool) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            interval.tick().await;
            if let Err(e) = tick(&app, &pool).await {
                eprintln!("[routine_scheduler] tick error: {e}");
            }
        }
    });
}

async fn tick(app: &AppHandle, pool: &SqlitePool) -> Result<(), String> {
    let rows = sqlx::query_as::<_, (String, String, String, Option<String>)>(
        "SELECT rt.id, rt.routine_id, r.company_id, r.concurrency_policy
         FROM routine_triggers rt
         JOIN routines r ON r.id = rt.routine_id
         WHERE rt.enabled = 1
           AND rt.next_run_at <= datetime('now')
           AND r.status = 'active'
         ORDER BY rt.next_run_at ASC
         LIMIT 20",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to query routine triggers: {e}"))?;

    for (trigger_id, routine_id, company_id, concurrency_policy) in rows {
        let policy = concurrency_policy.as_deref().unwrap_or("coalesce_if_active");

        // Check for active runs if policy requires it
        if policy == "coalesce_if_active" || policy == "skip_if_active" {
            let active_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM routine_runs WHERE routine_id = ? AND status IN ('received', 'running')",
            )
            .bind(&routine_id)
            .fetch_one(pool)
            .await
            .map_err(|e| format!("Failed to check active runs: {e}"))?;

            if active_count > 0 {
                // Update next_run_at so we don't keep hitting this trigger
                let _ = sqlx::query(
                    "UPDATE routine_triggers SET last_fired_at = datetime('now') WHERE id = ?",
                )
                .bind(&trigger_id)
                .execute(pool)
                .await;
                advance_next_run(pool, &trigger_id).await;
                continue;
            }
        }

        let run_id = uuid::Uuid::new_v4().to_string();

        sqlx::query(
            "INSERT INTO routine_runs (id, company_id, routine_id, trigger_id, source, status, triggered_at)
             VALUES (?, ?, ?, ?, 'scheduled', 'received', datetime('now'))",
        )
        .bind(&run_id)
        .bind(&company_id)
        .bind(&routine_id)
        .bind(&trigger_id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to create routine run: {e}"))?;

        // Update trigger timestamps
        let _ = sqlx::query(
            "UPDATE routine_triggers SET last_fired_at = datetime('now') WHERE id = ?",
        )
        .bind(&trigger_id)
        .execute(pool)
        .await;

        let _ = sqlx::query(
            "UPDATE routines SET last_triggered_at = datetime('now'), last_enqueued_at = datetime('now') WHERE id = ?",
        )
        .bind(&routine_id)
        .execute(pool)
        .await;

        advance_next_run(pool, &trigger_id).await;

        events::emit(
            app,
            AppEvent::RoutineTriggered {
                routine_id: routine_id.clone(),
                run_id,
            },
        );
    }

    Ok(())
}

/// Advance the next_run_at for a trigger based on its cron expression.
/// Simple implementation that adds the smallest cron interval.
async fn advance_next_run(pool: &SqlitePool, trigger_id: &str) {
    // Fetch the cron expression
    let row = sqlx::query_as::<_, (Option<String>,)>(
        "SELECT cron_expression FROM routine_triggers WHERE id = ?",
    )
    .bind(trigger_id)
    .fetch_optional(pool)
    .await;

    let cron_expr = match row {
        Ok(Some((Some(expr),))) => expr,
        _ => return,
    };

    // Simple cron interval computation: parse the minute/hour fields
    // to determine a reasonable next run offset
    let offset_seconds = compute_cron_interval(&cron_expr);

    let _ = sqlx::query(&format!(
        "UPDATE routine_triggers SET next_run_at = datetime('now', '+{offset_seconds} seconds') WHERE id = ?"
    ))
    .bind(trigger_id)
    .execute(pool)
    .await;
}

/// Compute interval in seconds from a 5-field cron expression.
/// Handles common patterns; defaults to 1 hour for complex expressions.
fn compute_cron_interval(cron: &str) -> i64 {
    let fields: Vec<&str> = cron.trim().split_whitespace().collect();
    if fields.len() < 5 {
        return 3600; // default 1 hour
    }

    let minute = fields[0];
    let hour = fields[1];

    // Every N minutes: */N * * * *
    if let Some(step) = minute.strip_prefix("*/") {
        if let Ok(n) = step.parse::<i64>() {
            return n * 60;
        }
    }

    // Every N hours: 0 */N * * *
    if let Some(step) = hour.strip_prefix("*/") {
        if let Ok(n) = step.parse::<i64>() {
            return n * 3600;
        }
    }

    // Fixed hour, fixed minute (daily): M H * * *
    if minute.parse::<i64>().is_ok() && hour.parse::<i64>().is_ok() {
        let day_of_week = fields[4];
        if day_of_week != "*" {
            // Weekly
            return 7 * 24 * 3600;
        }
        // Daily
        return 24 * 3600;
    }

    // Default: 1 hour
    3600
}
