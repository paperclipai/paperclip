use sqlx::SqlitePool;
use std::collections::HashMap;
use std::time::Duration;
use uuid::Uuid;

use crate::commands::secrets::get_secret_internal;
use crate::events;
use crate::services::adapter_host::{self, AdapterExecution};

fn is_local_adapter(adapter_type: &str) -> bool {
    matches!(adapter_type, "ollama_local" | "mlx_local")
}

pub async fn start_scheduler(app: tauri::AppHandle, pool: SqlitePool) {
    let mut interval = tokio::time::interval(Duration::from_secs(30));
    loop {
        interval.tick().await;
        if let Err(e) = process_tick(&app, &pool).await {
            eprintln!("[heartbeat] Tick error: {}", e);
        }
    }
}

async fn process_tick(app: &tauri::AppHandle, pool: &SqlitePool) -> Result<(), String> {
    // I2: Check and reset monthly budgets
    let _ = crate::services::budget::check_and_reset_monthly_budgets(pool).await;

    // Find queued wakeup requests
    let wakeups = sqlx::query_as::<_, (String, String, String, Option<String>, Option<String>)>(
        "SELECT id, agent_id, source, reason, payload FROM agent_wakeup_requests WHERE status = 'queued' ORDER BY created_at ASC LIMIT 5",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    for (wakeup_id, agent_id, source, reason, payload) in wakeups {
        if let Err(e) =
            process_wakeup(app, pool, &wakeup_id, &agent_id, &source, reason.as_deref(), payload.as_deref()).await
        {
            eprintln!("[heartbeat] Wakeup {} failed: {}", wakeup_id, e);
            // Mark wakeup as finished even on error
            let _ =
                sqlx::query("UPDATE agent_wakeup_requests SET status='finished' WHERE id=?")
                    .bind(&wakeup_id)
                    .execute(pool)
                    .await;
        }
    }
    Ok(())
}

async fn process_wakeup(
    app: &tauri::AppHandle,
    pool: &SqlitePool,
    wakeup_id: &str,
    agent_id: &str,
    source: &str,
    reason: Option<&str>,
    payload: Option<&str>,
) -> Result<(), String> {
    // 1. Claim wakeup atomically
    let claimed = sqlx::query(
        "UPDATE agent_wakeup_requests SET status='claimed' WHERE id=? AND status='queued'",
    )
    .bind(wakeup_id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    if claimed.rows_affected() == 0 {
        return Ok(()); // Already claimed by another tick
    }

    // 2. Load agent
    let agent = sqlx::query_as::<_, (String, String, String, String, i64, i64)>(
        "SELECT company_id, adapter_type, adapter_config, name, budget_monthly_cents, spent_monthly_cents FROM agents WHERE id=?",
    )
    .bind(agent_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or("Agent not found")?;

    let (company_id, adapter_type, adapter_config_str, agent_name, budget, spent) = agent;

    // 3. Check budget
    if budget > 0 && spent >= budget {
        sqlx::query("UPDATE agents SET status='paused', pause_reason='budget', paused_at=datetime('now') WHERE id=?")
            .bind(agent_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("UPDATE agent_wakeup_requests SET status='finished' WHERE id=?")
            .bind(wakeup_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        events::emit(
            app,
            events::AppEvent::AgentUpdated {
                agent_id: agent_id.to_string(),
            },
        );
        return Ok(());
    }

    // 4. Create heartbeat run
    let run_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO heartbeat_runs (id, company_id, agent_id, invocation_source, trigger_detail, status, started_at) VALUES (?,?,?,?,?,'running',datetime('now'))",
    )
    .bind(&run_id)
    .bind(&company_id)
    .bind(agent_id)
    .bind(source)
    .bind(reason)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    // 5. Emit start event
    events::emit(
        app,
        events::AppEvent::AgentRunStarted {
            agent_id: agent_id.to_string(),
            run_id: run_id.clone(),
        },
    );

    // 6. Resolve secrets
    let mut secrets = HashMap::new();
    if let Ok(key) = get_secret_internal("ANTHROPIC_API_KEY").await {
        secrets.insert("ANTHROPIC_API_KEY".to_string(), key);
    }
    if let Ok(key) = get_secret_internal("OPENAI_API_KEY").await {
        secrets.insert("OPENAI_API_KEY".to_string(), key);
    }
    if let Ok(key) = get_secret_internal("GEMINI_API_KEY").await {
        secrets.insert("GEMINI_API_KEY".to_string(), key);
    }

    // Inject agent API key if one exists
    if let Ok(agent_key) = crate::commands::secrets::get_secret_internal(&format!("AGENT_KEY_{}", agent_id)).await {
        secrets.insert("PAPERCLIP_AGENT_API_KEY".to_string(), agent_key);
    }

    // 7. Parse adapter config
    let config: serde_json::Value =
        serde_json::from_str(&adapter_config_str).unwrap_or(serde_json::json!({}));
    let cwd = config
        .get("cwd")
        .and_then(|v| v.as_str())
        .unwrap_or(".")
        .to_string();

    // Phase F3: Task-scoped sessions
    let issue_id_from_payload = payload
        .and_then(|p| serde_json::from_str::<serde_json::Value>(p).ok())
        .and_then(|v| v.get("issueId").and_then(|i| i.as_str()).map(String::from));
    let task_key = crate::services::session::derive_task_key(issue_id_from_payload.as_deref(), source);
    let session_id = if is_local_adapter(&adapter_type) {
        None
    } else {
        crate::services::session::resolve_session_for_task(
            pool, &company_id, agent_id, &adapter_type, &task_key, reason,
        )
        .await
    };

    // Phase F1: Build wake payload from wakeup request payload
    let wake_payload = crate::services::prompt::build_wake_payload(pool, &company_id, payload).await;
    let prompt = crate::services::prompt::render_wake_prompt(&wake_payload, &agent_name, session_id.is_some());

    // For local adapters, prepend instructions into the prompt (no session/instructions file support)
    let final_prompt = if is_local_adapter(&adapter_type) {
        let instructions_content = crate::services::instructions::read_instructions(&company_id, agent_id).unwrap_or_default();
        if instructions_content.is_empty() { prompt.clone() } else { format!("{}\n\n---\n\n{}", instructions_content, prompt) }
    } else {
        prompt.clone()
    };

    // L1: Extract cost attribution from wake payload
    let issue_id_for_cost = wake_payload.issue.as_ref().map(|i| i.id.clone());
    let (project_id_for_cost, billing_code_for_cost) = if let Some(ref iid) = issue_id_for_cost {
        sqlx::query_as::<_, (Option<String>, Option<String>)>(
            "SELECT project_id, billing_code FROM issues WHERE id = ?"
        ).bind(iid).fetch_optional(pool).await.ok().flatten().unwrap_or((None, None))
    } else { (None, None) };

    // Phase F2: Resolve instructions
    let instructions_path = if is_local_adapter(&adapter_type) {
        None
    } else {
        crate::services::instructions::resolve_for_run(
            &config, &company_id, agent_id, session_id.is_some(),
        )
    };

    // Phase G2: Materialize skills
    let skills_dir_path = crate::services::skills::materialize_skills_for_run(pool, agent_id, &company_id).await;
    let skills_dir = skills_dir_path.clone();

    // Phase G1: Realize workspace
    let mut workspace_id: Option<String> = None;
    let resolved_cwd = if let Some(ref issue_sum) = wake_payload.issue {
        // Check if issue has a project with a workspace
        let project_ws = sqlx::query_as::<_, (String,)>(
            "SELECT pw.cwd FROM project_workspaces pw JOIN issues i ON i.project_id = pw.project_id WHERE i.id = ? AND pw.is_primary = 1 LIMIT 1",
        )
        .bind(&issue_sum.id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();

        if let Some((project_cwd,)) = project_ws {
            let ws_config = crate::services::execution_workspaces::WorktreeConfig::default();
            match crate::services::execution_workspaces::realize_workspace(
                pool,
                &company_id,
                agent_id,
                Some(&issue_sum.identifier),
                Some(&issue_sum.title),
                &project_cwd,
                &ws_config,
            )
            .await
            {
                Ok(ws) => {
                    workspace_id = Some(ws.workspace_id);
                    ws.cwd
                }
                Err(e) => {
                    eprintln!(
                        "[heartbeat] Workspace realization failed: {}, using config cwd",
                        e
                    );
                    cwd.clone()
                }
            }
        } else {
            cwd.clone()
        }
    } else {
        cwd.clone()
    };

    // M1: Start runtime services if configured
    let config_for_services: serde_json::Value = serde_json::from_str(&adapter_config_str).unwrap_or_default();
    if let Some(services_arr) = config_for_services.get("runtimeServices").and_then(|v| v.as_array()) {
        let rt_services = crate::services::workspace_runtime::RuntimeServices::new();
        for svc in services_arr {
            let svc_name = svc.get("name").and_then(|v| v.as_str()).unwrap_or("default");
            let svc_cmd = svc.get("command").and_then(|v| v.as_str()).unwrap_or("");
            if !svc_cmd.is_empty() {
                let _ = rt_services.start_service(svc_name, svc_cmd, &resolved_cwd).await;
            }
        }
    }

    // 10. Execute adapter
    let exec = AdapterExecution {
        run_id: run_id.clone(),
        agent_id: agent_id.to_string(),
        company_id: company_id.clone(),
        adapter_type: adapter_type.clone(),
        adapter_config: config,
        prompt: final_prompt,
        cwd: resolved_cwd,
        timeout_sec: 300,
        session_id,
        instructions_path,
        skills_dir,
    };

    let result = adapter_host::execute(exec, app.clone(), secrets).await;

    match result {
        Ok(result) => {
            // Phase F4: Parse transcript for Claude adapters
            let transcript = if adapter_type == "claude_local" {
                Some(adapter_host::parse_claude_stream_json(&result.stdout))
            } else {
                None
            };

            // Use transcript data when available, fall back to AdapterResult fields
            let effective_usage = transcript.as_ref().and_then(|t| t.usage.clone()).or(result.usage.clone());
            let effective_session_id = transcript.as_ref().and_then(|t| t.session_id.clone()).or(result.session_id.clone());
            let result_summary = transcript.as_ref().map(|t| t.summary.clone());

            // 11. Record costs
            if is_local_adapter(&adapter_type) {
                // Record zero-cost event for analytics
                let cost_id = Uuid::new_v4().to_string();
                let model_name = serde_json::from_str::<serde_json::Value>(&adapter_config_str)
                    .ok().and_then(|c| c.get("model").and_then(|v| v.as_str()).map(String::from))
                    .unwrap_or_else(|| "gemma4:e4b".to_string());
                let _ = sqlx::query(
                    "INSERT INTO cost_events (id, company_id, agent_id, heartbeat_run_id, model, cost_cents, provider, issue_id, project_id) VALUES (?,?,?,?,?,0,'local',?,?)"
                ).bind(&cost_id).bind(&company_id).bind(agent_id).bind(&run_id)
                    .bind(&model_name).bind(&issue_id_for_cost).bind(&project_id_for_cost)
                    .execute(pool).await;
            } else if let Some(ref usage) = effective_usage {
                let cost_id = Uuid::new_v4().to_string();
                let cost_cents = (usage.cost_usd * 100.0) as i64;
                let _ = sqlx::query(
                    "INSERT INTO cost_events (id, company_id, agent_id, heartbeat_run_id, model, input_tokens, output_tokens, cached_input_tokens, cost_cents, provider, issue_id, project_id, billing_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                )
                .bind(&cost_id)
                .bind(&company_id)
                .bind(agent_id)
                .bind(&run_id)
                .bind(&usage.model)
                .bind(usage.input_tokens)
                .bind(usage.output_tokens)
                .bind(usage.cached_input_tokens)
                .bind(cost_cents)
                .bind("anthropic")
                .bind(&issue_id_for_cost)
                .bind(&project_id_for_cost)
                .bind(&billing_code_for_cost)
                .execute(pool)
                .await;

                let _ = sqlx::query(
                    "UPDATE agents SET spent_monthly_cents = spent_monthly_cents + ?, last_heartbeat_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
                )
                .bind(cost_cents)
                .bind(agent_id)
                .execute(pool)
                .await;

                // Post-execution budget check (inline agent budget)
                let new_spent = spent + cost_cents;
                if budget > 0 && new_spent >= budget {
                    let _ = sqlx::query("UPDATE agents SET status='paused', pause_reason='budget', paused_at=datetime('now') WHERE id=? AND status != 'paused'")
                        .bind(agent_id).execute(pool).await;
                    // Create budget incident
                    let incident_id = Uuid::new_v4().to_string();
                    let _ = sqlx::query("INSERT INTO budget_incidents (id, company_id, scope_type, scope_id, metric, window_kind, amount_limit, amount_observed, status) VALUES (?, ?, 'agent', ?, 'billed_cents', 'monthly', ?, ?, 'open')")
                        .bind(&incident_id).bind(&company_id).bind(agent_id).bind(budget).bind(new_spent)
                        .execute(pool).await;
                    events::emit(app, events::AppEvent::AgentUpdated { agent_id: agent_id.to_string() });
                }

                // I2: Enforce budget policies (company-wide and agent-scoped)
                let _ = crate::services::budget::enforce_budget_policies(pool, app, &company_id, agent_id, cost_cents).await;
            }

            // 12. Update run status
            let status = if result.timed_out {
                "timed_out"
            } else if result.exit_code == 0 {
                "succeeded"
            } else {
                "failed"
            };
            let excerpt = if result.stdout.len() > 4096 {
                &result.stdout[..4096]
            } else {
                &result.stdout
            };
            let usage_json = serde_json::to_string(&effective_usage).unwrap_or_default();
            let result_json = result_summary.as_deref().unwrap_or("");

            let _ = sqlx::query(
                "UPDATE heartbeat_runs SET status=?, finished_at=datetime('now'), exit_code=?, stdout_excerpt=?, usage_json=?, result_json=?, error=? WHERE id=?",
            )
            .bind(status)
            .bind(result.exit_code)
            .bind(excerpt)
            .bind(&usage_json)
            .bind(result_json)
            .bind(if result.exit_code != 0 {
                Some(result.stderr.as_str())
            } else {
                None::<&str>
            })
            .bind(&run_id)
            .execute(pool)
            .await;

            // 13. Update session (agent_runtime_state for backward compat)
            if let Some(ref sid) = effective_session_id {
                let _ = sqlx::query(
                    "INSERT INTO agent_runtime_state (agent_id, company_id, adapter_type, session_id, last_run_id, last_run_status, updated_at) VALUES (?,?,?,?,?,?,datetime('now')) ON CONFLICT(agent_id) DO UPDATE SET session_id=excluded.session_id, last_run_id=excluded.last_run_id, last_run_status=excluded.last_run_status, updated_at=datetime('now')",
                )
                .bind(agent_id)
                .bind(&company_id)
                .bind(&adapter_type)
                .bind(sid)
                .bind(&run_id)
                .bind(status)
                .execute(pool)
                .await;
            }

            // Phase F3: Record task-scoped session
            if let Some(ref transcript) = transcript {
                if let Some(ref new_sid) = transcript.session_id {
                    let input_tokens = transcript.usage.as_ref().map(|u| u.input_tokens).unwrap_or(0);
                    let _ = crate::services::session::record_session_for_task(
                        pool, &company_id, agent_id, &adapter_type, &task_key, new_sid, &run_id, input_tokens,
                    )
                    .await;
                }
            }

            // M3: Store skills snapshot after successful run
            if skills_dir_path.is_some() {
                let skill_names: Vec<String> = sqlx::query_scalar::<_, String>(
                    "SELECT cs.name FROM company_skills cs JOIN agent_skills ags ON cs.id = ags.skill_id WHERE ags.agent_id = ?"
                ).bind(agent_id).fetch_all(pool).await.unwrap_or_default();

                let existing_state: String = sqlx::query_scalar::<_, String>(
                    "SELECT COALESCE(state_json, '{}') FROM agent_runtime_state WHERE agent_id = ?"
                ).bind(agent_id).fetch_optional(pool).await.ok().flatten().unwrap_or_else(|| "{}".to_string());

                let mut state: serde_json::Value = serde_json::from_str(&existing_state).unwrap_or(serde_json::json!({}));
                state["skills_snapshot"] = serde_json::json!(skill_names);

                let _ = sqlx::query("UPDATE agent_runtime_state SET state_json = ?, updated_at = datetime('now') WHERE agent_id = ?")
                    .bind(serde_json::to_string(&state).unwrap_or_default())
                    .bind(agent_id)
                    .execute(pool).await;
            }

            // 14. Emit completion
            if status == "succeeded" {
                events::emit(
                    app,
                    events::AppEvent::AgentRunCompleted {
                        agent_id: agent_id.to_string(),
                        run_id: run_id.clone(),
                        status: status.to_string(),
                    },
                );
            } else {
                events::emit(
                    app,
                    events::AppEvent::AgentRunFailed {
                        agent_id: agent_id.to_string(),
                        run_id: run_id.clone(),
                        error: result.stderr.clone(),
                    },
                );
            }
        }
        Err(e) => {
            // Execution failed entirely
            let _ = sqlx::query(
                "UPDATE heartbeat_runs SET status='failed', finished_at=datetime('now'), error=? WHERE id=?",
            )
            .bind(&e)
            .bind(&run_id)
            .execute(pool)
            .await;

            events::emit(
                app,
                events::AppEvent::AgentRunFailed {
                    agent_id: agent_id.to_string(),
                    run_id: run_id.clone(),
                    error: e,
                },
            );
        }
    }

    // 15. Cleanup workspace and skills
    if let Some(ref ws_id) = workspace_id {
        let _ = crate::services::execution_workspaces::release_workspace(pool, ws_id, false).await;
    }
    if let Some(ref sd) = skills_dir_path {
        crate::services::skills::cleanup_skills_dir(sd);
    }

    // 16. Mark wakeup finished
    let _ =
        sqlx::query("UPDATE agent_wakeup_requests SET status='finished', run_id=? WHERE id=?")
            .bind(&run_id)
            .bind(wakeup_id)
            .execute(pool)
            .await;

    Ok(())
}
