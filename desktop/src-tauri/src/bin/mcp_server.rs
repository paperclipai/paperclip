use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::io::{self, BufRead, Write};
use std::str::FromStr;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let db_path = dirs::data_dir()
        .unwrap_or_default()
        .join("com.archonos.app")
        .join("archonos.db");

    let db_url = format!("sqlite:{}?mode=rwc", db_path.display());
    let options = SqliteConnectOptions::from_str(&db_url)?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);

    let pool = SqlitePoolOptions::new()
        .max_connections(3)
        .connect_with(options)
        .await?;

    let stdin = io::stdin();
    let stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let request: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let method = request
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let id = request.get("id").cloned();
        let params = request
            .get("params")
            .cloned()
            .unwrap_or(serde_json::json!({}));

        let result = match method {
            "initialize" => {
                serde_json::json!({
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "archonos", "version": "0.1.0" }
                })
            }
            "tools/list" => {
                serde_json::json!({
                    "tools": get_tool_definitions()
                })
            }
            "tools/call" => {
                let tool_name = params
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let args = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or(serde_json::json!({}));
                handle_tool_call(&pool, tool_name, args).await
            }
            _ => serde_json::json!({"error": "Method not found"}),
        };

        if let Some(id) = id {
            let response = serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": result,
            });
            let mut out = stdout.lock();
            serde_json::to_writer(&mut out, &response)?;
            out.write_all(b"\n")?;
            out.flush()?;
        }
    }

    Ok(())
}

fn get_tool_definitions() -> Vec<serde_json::Value> {
    vec![
        tool_def(
            "list_agents",
            "List all agents in the company",
            serde_json::json!({"type":"object","properties":{"company_id":{"type":"string"}},"required":["company_id"]}),
        ),
        tool_def(
            "get_agent",
            "Get agent details",
            serde_json::json!({"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}),
        ),
        tool_def(
            "wake_agent",
            "Wake an agent",
            serde_json::json!({"type":"object","properties":{"id":{"type":"string"},"reason":{"type":"string"}},"required":["id"]}),
        ),
        tool_def(
            "list_issues",
            "List issues",
            serde_json::json!({"type":"object","properties":{"company_id":{"type":"string"}},"required":["company_id"]}),
        ),
        tool_def(
            "create_issue",
            "Create an issue",
            serde_json::json!({"type":"object","properties":{"company_id":{"type":"string"},"title":{"type":"string"}},"required":["company_id","title"]}),
        ),
        tool_def(
            "update_issue",
            "Update an issue",
            serde_json::json!({"type":"object","properties":{"id":{"type":"string"},"status":{"type":"string"}},"required":["id"]}),
        ),
        tool_def(
            "add_comment",
            "Add a comment to an issue",
            serde_json::json!({"type":"object","properties":{"company_id":{"type":"string"},"issue_id":{"type":"string"},"body":{"type":"string"}},"required":["company_id","issue_id","body"]}),
        ),
        tool_def(
            "list_projects",
            "List projects",
            serde_json::json!({"type":"object","properties":{"company_id":{"type":"string"}},"required":["company_id"]}),
        ),
        tool_def(
            "list_goals",
            "List goals",
            serde_json::json!({"type":"object","properties":{"company_id":{"type":"string"}},"required":["company_id"]}),
        ),
        tool_def(
            "list_approvals",
            "List pending approvals",
            serde_json::json!({"type":"object","properties":{"company_id":{"type":"string"}},"required":["company_id"]}),
        ),
        tool_def(
            "approve",
            "Approve a request",
            serde_json::json!({"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}),
        ),
        tool_def(
            "reject",
            "Reject a request",
            serde_json::json!({"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}),
        ),
        tool_def(
            "get_cost_summary",
            "Get cost summary",
            serde_json::json!({"type":"object","properties":{"company_id":{"type":"string"}},"required":["company_id"]}),
        ),
        tool_def(
            "search_issues",
            "Search issues by text",
            serde_json::json!({"type":"object","properties":{"company_id":{"type":"string"},"query":{"type":"string"}},"required":["company_id","query"]}),
        ),
    ]
}

fn tool_def(name: &str, desc: &str, schema: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "name": name,
        "description": desc,
        "inputSchema": schema,
    })
}

async fn handle_tool_call(
    pool: &sqlx::SqlitePool,
    name: &str,
    args: serde_json::Value,
) -> serde_json::Value {
    let result = match name {
        "list_agents" => {
            let cid = args
                .get("company_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let rows = sqlx::query_as::<_, (String, String, String, String)>(
                "SELECT id, name, role, status FROM agents WHERE company_id = ? AND status != 'terminated'",
            )
            .bind(cid)
            .fetch_all(pool)
            .await
            .unwrap_or_default();
            let agents: Vec<serde_json::Value> = rows
                .iter()
                .map(|r| {
                    serde_json::json!({"id":r.0,"name":r.1,"role":r.2,"status":r.3})
                })
                .collect();
            serde_json::to_string_pretty(&agents).unwrap_or_default()
        }
        "get_agent" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let row = sqlx::query_as::<_, (String, String, String, String, String)>(
                "SELECT id, name, role, adapter_type, status FROM agents WHERE id = ?",
            )
            .bind(id)
            .fetch_optional(pool)
            .await
            .unwrap_or(None);
            match row {
                Some(r) => serde_json::to_string(
                    &serde_json::json!({"id":r.0,"name":r.1,"role":r.2,"adapter":r.3,"status":r.4}),
                )
                .unwrap_or_default(),
                None => "Agent not found".into(),
            }
        }
        "wake_agent" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let reason = args
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("mcp_tool");
            let wid = uuid::Uuid::new_v4().to_string();
            let _ = sqlx::query("INSERT INTO agent_wakeup_requests (id, company_id, agent_id, source, reason) VALUES (?, (SELECT company_id FROM agents WHERE id = ?), ?, 'mcp', ?)")
                .bind(&wid)
                .bind(id)
                .bind(id)
                .bind(reason)
                .execute(pool)
                .await;
            format!("Wakeup request created: {}", wid)
        }
        "list_issues" => {
            let cid = args
                .get("company_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let rows = sqlx::query_as::<_, (String, String, String, String)>(
                "SELECT identifier, title, status, priority FROM issues WHERE company_id = ? AND hidden_at IS NULL ORDER BY created_at DESC LIMIT 25",
            )
            .bind(cid)
            .fetch_all(pool)
            .await
            .unwrap_or_default();
            let issues: Vec<serde_json::Value> = rows
                .iter()
                .map(|r| {
                    serde_json::json!({"identifier":r.0,"title":r.1,"status":r.2,"priority":r.3})
                })
                .collect();
            serde_json::to_string_pretty(&issues).unwrap_or_default()
        }
        "create_issue" => {
            let cid = args
                .get("company_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let title = args
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let id = uuid::Uuid::new_v4().to_string();
            let next_num: i64 = sqlx::query_scalar(
                "SELECT COALESCE(MAX(issue_number), 0) + 1 FROM issues WHERE company_id = ?",
            )
            .bind(cid)
            .fetch_one(pool)
            .await
            .unwrap_or(1);
            let prefix: String = sqlx::query_scalar(
                "SELECT issue_prefix FROM companies WHERE id = ?",
            )
            .bind(cid)
            .fetch_one(pool)
            .await
            .unwrap_or_default();
            let identifier = format!("{}-{}", prefix, next_num);
            let _ = sqlx::query(
                "INSERT INTO issues (id, company_id, issue_number, identifier, title) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(cid)
            .bind(next_num)
            .bind(&identifier)
            .bind(title)
            .execute(pool)
            .await;
            format!("Created issue {}", identifier)
        }
        "update_issue" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let status = args
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !status.is_empty() {
                let _ = sqlx::query(
                    "UPDATE issues SET status=?, updated_at=datetime('now') WHERE id=?",
                )
                .bind(status)
                .bind(id)
                .execute(pool)
                .await;
            }
            format!("Updated issue {}", id)
        }
        "add_comment" => {
            let cid = args
                .get("company_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let iid = args
                .get("issue_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let body = args
                .get("body")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let id = uuid::Uuid::new_v4().to_string();
            let _ = sqlx::query("INSERT INTO issue_comments (id, company_id, issue_id, author_user_id, body) VALUES (?, ?, ?, 'mcp', ?)")
                .bind(&id)
                .bind(cid)
                .bind(iid)
                .bind(body)
                .execute(pool)
                .await;
            "Comment added".to_string()
        }
        "list_projects" => {
            let cid = args
                .get("company_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let rows = sqlx::query_as::<_, (String, String, String)>(
                "SELECT id, name, status FROM projects WHERE company_id = ? ORDER BY created_at DESC",
            )
            .bind(cid)
            .fetch_all(pool)
            .await
            .unwrap_or_default();
            serde_json::to_string_pretty(
                &rows
                    .iter()
                    .map(|r| serde_json::json!({"id":r.0,"name":r.1,"status":r.2}))
                    .collect::<Vec<_>>(),
            )
            .unwrap_or_default()
        }
        "list_goals" => {
            let cid = args
                .get("company_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let rows = sqlx::query_as::<_, (String, String, String)>(
                "SELECT id, title, status FROM goals WHERE company_id = ? ORDER BY created_at DESC",
            )
            .bind(cid)
            .fetch_all(pool)
            .await
            .unwrap_or_default();
            serde_json::to_string_pretty(
                &rows
                    .iter()
                    .map(|r| serde_json::json!({"id":r.0,"title":r.1,"status":r.2}))
                    .collect::<Vec<_>>(),
            )
            .unwrap_or_default()
        }
        "list_approvals" => {
            let cid = args
                .get("company_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let rows = sqlx::query_as::<_, (String, String, String)>(
                "SELECT id, type, status FROM approvals WHERE company_id = ? AND status = 'pending'",
            )
            .bind(cid)
            .fetch_all(pool)
            .await
            .unwrap_or_default();
            serde_json::to_string_pretty(
                &rows
                    .iter()
                    .map(|r| serde_json::json!({"id":r.0,"type":r.1,"status":r.2}))
                    .collect::<Vec<_>>(),
            )
            .unwrap_or_default()
        }
        "approve" | "reject" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let status = if name == "approve" {
                "approved"
            } else {
                "rejected"
            };
            let _ = sqlx::query(
                "UPDATE approvals SET status=?, decided_at=datetime('now') WHERE id=?",
            )
            .bind(status)
            .bind(id)
            .execute(pool)
            .await;
            format!("Approval {} {}", id, status)
        }
        "get_cost_summary" => {
            let cid = args
                .get("company_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let row = sqlx::query_as::<_, (i64, i64, i64)>(
                "SELECT COALESCE(SUM(cost_cents),0), COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0) FROM cost_events WHERE company_id = ?",
            )
            .bind(cid)
            .fetch_one(pool)
            .await
            .unwrap_or((0, 0, 0));
            serde_json::to_string(
                &serde_json::json!({"cost_cents":row.0,"input_tokens":row.1,"output_tokens":row.2}),
            )
            .unwrap_or_default()
        }
        "search_issues" => {
            let cid = args
                .get("company_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let q = args
                .get("query")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let pattern = format!("%{}%", q);
            let rows = sqlx::query_as::<_, (String, String, String)>(
                "SELECT identifier, title, status FROM issues WHERE company_id = ? AND hidden_at IS NULL AND (title LIKE ? OR identifier LIKE ?) LIMIT 20",
            )
            .bind(cid)
            .bind(&pattern)
            .bind(&pattern)
            .fetch_all(pool)
            .await
            .unwrap_or_default();
            serde_json::to_string_pretty(
                &rows
                    .iter()
                    .map(|r| {
                        serde_json::json!({"identifier":r.0,"title":r.1,"status":r.2})
                    })
                    .collect::<Vec<_>>(),
            )
            .unwrap_or_default()
        }
        _ => format!("Unknown tool: {}", name),
    };

    serde_json::json!({
        "content": [{"type": "text", "text": result}]
    })
}
