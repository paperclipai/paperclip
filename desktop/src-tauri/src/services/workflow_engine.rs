use crate::events::{self, AppEvent};
use serde::Deserialize;
use sqlx::SqlitePool;
use tauri::AppHandle;

#[derive(Debug, Deserialize)]
struct WorkflowGraph {
    #[serde(default)]
    nodes: Vec<WorkflowNode>,
    #[serde(default)]
    edges: Vec<WorkflowEdge>,
}

#[derive(Debug, Deserialize)]
struct WorkflowNode {
    id: String,
    #[serde(rename = "type")]
    node_type: String,
    #[serde(default)]
    config: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct WorkflowEdge {
    source: String,
    target: String,
    #[serde(default)]
    condition: Option<String>,
}

pub async fn execute_workflow(app: AppHandle, pool: SqlitePool, run_id: String) {
    tokio::spawn(async move {
        if let Err(e) = run_workflow(&app, &pool, &run_id).await {
            eprintln!("[workflow_engine] workflow {run_id} failed: {e}");
            let _ = sqlx::query(
                "UPDATE workflow_runs SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = ?",
            )
            .bind(&e)
            .bind(&run_id)
            .execute(&pool)
            .await;

            events::emit(
                &app,
                AppEvent::WorkflowRunCompleted {
                    run_id,
                    status: "failed".to_string(),
                },
            );
        }
    });
}

async fn run_workflow(app: &AppHandle, pool: &SqlitePool, run_id: &str) -> Result<(), String> {
    // Fetch workflow graph
    let (workflow_id,): (String,) = sqlx::query_as(
        "SELECT workflow_id FROM workflow_runs WHERE id = ?",
    )
    .bind(run_id)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("Failed to fetch workflow run: {e}"))?;

    let (graph_json,): (String,) = sqlx::query_as(
        "SELECT graph FROM workflows WHERE id = ?",
    )
    .bind(&workflow_id)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("Failed to fetch workflow: {e}"))?;

    let graph: WorkflowGraph =
        serde_json::from_str(&graph_json).map_err(|e| format!("Invalid workflow graph JSON: {e}"))?;

    if graph.nodes.is_empty() {
        // Empty graph, mark as completed
        let _ = sqlx::query(
            "UPDATE workflow_runs SET status = 'completed', completed_at = datetime('now') WHERE id = ?",
        )
        .bind(run_id)
        .execute(pool)
        .await;

        events::emit(
            app,
            AppEvent::WorkflowRunCompleted {
                run_id: run_id.to_string(),
                status: "completed".to_string(),
            },
        );
        return Ok(());
    }

    // Build adjacency: source → [target]
    let mut adjacency: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for edge in &graph.edges {
        adjacency
            .entry(edge.source.clone())
            .or_default()
            .push(edge.target.clone());
    }

    // Find start node: a node not targeted by any edge
    let targets: std::collections::HashSet<&str> =
        graph.edges.iter().map(|e| e.target.as_str()).collect();
    let start_node = graph
        .nodes
        .iter()
        .find(|n| !targets.contains(n.id.as_str()))
        .ok_or_else(|| "No start node found in workflow graph".to_string())?;

    // Walk the graph linearly
    let node_map: std::collections::HashMap<&str, &WorkflowNode> =
        graph.nodes.iter().map(|n| (n.id.as_str(), n)).collect();

    let mut current_id = start_node.id.clone();

    loop {
        let node = node_map
            .get(current_id.as_str())
            .ok_or_else(|| format!("Node not found: {current_id}"))?;

        // Update current node
        let _ = sqlx::query(
            "UPDATE workflow_runs SET current_node_id = ? WHERE id = ?",
        )
        .bind(&current_id)
        .bind(run_id)
        .execute(pool)
        .await;

        events::emit(
            app,
            AppEvent::WorkflowNodeStarted {
                run_id: run_id.to_string(),
                node_id: current_id.clone(),
            },
        );

        // Execute node based on type
        execute_node(pool, node).await?;

        events::emit(
            app,
            AppEvent::WorkflowNodeCompleted {
                run_id: run_id.to_string(),
                node_id: current_id.clone(),
            },
        );

        // Find next node
        match adjacency.get(&current_id) {
            Some(targets) if !targets.is_empty() => {
                current_id = targets[0].clone();
            }
            _ => break, // No more nodes
        }
    }

    // Mark workflow as completed
    let _ = sqlx::query(
        "UPDATE workflow_runs SET status = 'completed', completed_at = datetime('now') WHERE id = ?",
    )
    .bind(run_id)
    .execute(pool)
    .await;

    events::emit(
        app,
        AppEvent::WorkflowRunCompleted {
            run_id: run_id.to_string(),
            status: "completed".to_string(),
        },
    );

    Ok(())
}

async fn execute_node(pool: &SqlitePool, node: &WorkflowNode) -> Result<(), String> {
    match node.node_type.as_str() {
        "agent_task" => {
            // Create a wakeup request for the specified agent
            let agent_id = node
                .config
                .get("agent_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let company_id = node
                .config
                .get("company_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let reason = node
                .config
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("workflow");

            let wakeup_id = uuid::Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO agent_wakeup_requests (id, company_id, agent_id, source, reason, status)
                 VALUES (?, ?, ?, 'workflow', ?, 'queued')",
            )
            .bind(&wakeup_id)
            .bind(company_id)
            .bind(agent_id)
            .bind(reason)
            .execute(pool)
            .await
            .map_err(|e| format!("Failed to create wakeup request: {e}"))?;
        }
        "decision" => {
            // Evaluate a simple condition — for now, always passes
            // Future: evaluate condition expression against workflow state
        }
        "approval" => {
            // Create an approval record
            let company_id = node
                .config
                .get("company_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let approval_id = uuid::Uuid::new_v4().to_string();
            let payload = node.config.get("payload").cloned().unwrap_or(serde_json::json!({}));

            sqlx::query(
                "INSERT INTO approvals (id, company_id, type, payload, status)
                 VALUES (?, ?, 'workflow', ?, 'pending')",
            )
            .bind(&approval_id)
            .bind(company_id)
            .bind(payload.to_string())
            .execute(pool)
            .await
            .map_err(|e| format!("Failed to create approval: {e}"))?;
        }
        "transform" => {
            // No-op placeholder for data transformation nodes
        }
        "delay" => {
            let seconds = node
                .config
                .get("seconds")
                .and_then(|v| v.as_u64())
                .unwrap_or(1);
            tokio::time::sleep(std::time::Duration::from_secs(seconds)).await;
        }
        "webhook" => {
            // No-op placeholder for webhook nodes
        }
        other => {
            eprintln!("[workflow_engine] unknown node type: {other}");
        }
    }

    Ok(())
}
