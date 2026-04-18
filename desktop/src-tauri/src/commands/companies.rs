use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize, Clone, FromRow)]
pub struct Company {
    pub id: String,
    pub name: String,
    pub issue_prefix: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateCompanyInput {
    pub name: String,
    pub issue_prefix: String,
}

#[tauri::command]
pub async fn list_companies(pool: State<'_, DbPool>) -> Result<Vec<Company>, String> {
    let p = &pool.0;

    sqlx::query_as::<_, Company>(
        "SELECT id, name, issue_prefix, status, created_at, updated_at FROM companies WHERE status = 'active' ORDER BY created_at",
    )
    .fetch_all(p)
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_company(
    pool: State<'_, DbPool>,
    data: CreateCompanyInput,
) -> Result<Company, String> {
    let p = &pool.0;

    let id = Uuid::new_v4().to_string();
    let prefix = data.issue_prefix.to_uppercase();

    sqlx::query("INSERT INTO companies (id, name, issue_prefix) VALUES (?, ?, ?)")
        .bind(&id)
        .bind(&data.name)
        .bind(&prefix)
        .execute(p)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query_as::<_, Company>(
        "SELECT id, name, issue_prefix, status, created_at, updated_at FROM companies WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(p)
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_company(pool: State<'_, DbPool>, id: String) -> Result<Company, String> {
    let p = &pool.0;

    sqlx::query_as::<_, Company>(
        "SELECT id, name, issue_prefix, status, created_at, updated_at FROM companies WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(p)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Company not found".to_string())
}

#[tauri::command]
pub async fn export_company(pool: State<'_, DbPool>, company_id: String) -> Result<String, String> {
    let p = &pool.0;

    let company = sqlx::query_as::<_, Company>(
        "SELECT id, name, issue_prefix, status, created_at, updated_at FROM companies WHERE id = ?"
    ).bind(&company_id).fetch_optional(p).await.map_err(|e| e.to_string())?
        .ok_or("Company not found")?;

    let agents: Vec<serde_json::Value> = sqlx::query_as::<_, (String, String, String, Option<String>, String, String, String, i64, Option<String>)>(
        "SELECT id, name, role, title, adapter_type, adapter_config, status, budget_monthly_cents, reports_to FROM agents WHERE company_id = ? AND status != 'terminated'"
    ).bind(&company_id).fetch_all(p).await.map_err(|e| e.to_string())?
        .iter().map(|a| serde_json::json!({
            "id": a.0, "name": a.1, "role": a.2, "title": a.3,
            "adapter_type": a.4, "adapter_config": a.5, "status": a.6, "budget_monthly_cents": a.7,
            "reports_to": a.8
        })).collect();

    let projects: Vec<serde_json::Value> = sqlx::query_as::<_, (String, String, Option<String>, String)>(
        "SELECT id, name, description, status FROM projects WHERE company_id = ? AND archived_at IS NULL"
    ).bind(&company_id).fetch_all(p).await.map_err(|e| e.to_string())?
        .iter().map(|p| serde_json::json!({"id": p.0, "name": p.1, "description": p.2, "status": p.3})).collect();

    let issues: Vec<serde_json::Value> = sqlx::query_as::<_, (String, String, String, String, String, Option<String>)>(
        "SELECT id, identifier, title, status, priority, assignee_agent_id FROM issues WHERE company_id = ? AND hidden_at IS NULL"
    ).bind(&company_id).fetch_all(p).await.map_err(|e| e.to_string())?
        .iter().map(|i| serde_json::json!({"id": i.0, "identifier": i.1, "title": i.2, "status": i.3, "priority": i.4, "assignee_agent_id": i.5})).collect();

    let goals: Vec<serde_json::Value> = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT id, title, level, status FROM goals WHERE company_id = ?"
    ).bind(&company_id).fetch_all(p).await.map_err(|e| e.to_string())?
        .iter().map(|g| serde_json::json!({"id": g.0, "title": g.1, "level": g.2, "status": g.3})).collect();

    let skills: Vec<serde_json::Value> = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT skill_key, slug, name, markdown FROM company_skills WHERE company_id = ?"
    ).bind(&company_id).fetch_all(p).await.map_err(|e| e.to_string())?
        .iter().map(|s| serde_json::json!({"skill_key": s.0, "slug": s.1, "name": s.2, "markdown": s.3})).collect();

    let routines: Vec<serde_json::Value> = sqlx::query_as::<_, (String, String, Option<String>, String, String)>(
        "SELECT id, title, description, concurrency_policy, catch_up_policy FROM routines WHERE company_id = ? AND status != 'archived'"
    ).bind(&company_id).fetch_all(p).await.map_err(|e| e.to_string())?
        .iter().map(|r| serde_json::json!({"id": r.0, "title": r.1, "description": r.2, "concurrency_policy": r.3, "catch_up_policy": r.4})).collect();

    let config_revisions: Vec<serde_json::Value> = sqlx::query_as::<_, (String, String, String, String, String, String)>(
        "SELECT id, agent_id, source, changed_keys, before_config, created_at FROM agent_config_revisions WHERE company_id = ? ORDER BY created_at"
    ).bind(&company_id).fetch_all(p).await.map_err(|e| e.to_string())?
        .iter().map(|r| serde_json::json!({"id": r.0, "agent_id": r.1, "source": r.2, "changed_keys": r.3, "before_config": r.4, "created_at": r.5})).collect();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string();

    let bundle = serde_json::json!({
        "schema": "archonos/v3",
        "exported_at": now,
        "company": company,
        "agents": agents,
        "projects": projects,
        "issues": issues,
        "goals": goals,
        "skills": skills,
        "routines": routines,
        "config_revisions": config_revisions,
    });

    serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())
}

const CREATOR_BUSINESS_OS: &str = include_str!("../data/creator_business_os.json");

async fn import_company_internal(pool: &sqlx::SqlitePool, json_data: String) -> Result<Company, String> {
    let bundle: serde_json::Value = serde_json::from_str(&json_data).map_err(|e| format!("Invalid JSON: {}", e))?;

    // Validate schema (accept both v1 and v2)
    let schema = bundle.get("schema").and_then(|v| v.as_str()).unwrap_or("");
    if schema != "archonos/v1" && schema != "archonos/v2" && schema != "archonos/v3" {
        return Err("Invalid or missing schema version. Expected archonos/v1, v2, or v3".to_string());
    }

    // Create company
    let company_data = bundle.get("company").ok_or("Missing company data")?;
    let name = company_data.get("name").and_then(|v| v.as_str()).ok_or("Missing company name")?;
    let prefix = company_data.get("issue_prefix").and_then(|v| v.as_str()).ok_or("Missing issue prefix")?;

    let company_id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO companies (id, name, issue_prefix) VALUES (?, ?, ?)")
        .bind(&company_id).bind(name).bind(prefix)
        .execute(pool).await.map_err(|e| e.to_string())?;

    // Import agents (map old IDs to new IDs, and names to new IDs)
    let mut agent_id_map: HashMap<String, String> = HashMap::new();
    let mut agent_name_map: HashMap<String, String> = HashMap::new();
    if let Some(agents) = bundle.get("agents").and_then(|v| v.as_array()) {
        for agent in agents {
            let old_id = agent.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let new_id = Uuid::new_v4().to_string();
            let agent_name = agent.get("name").and_then(|v| v.as_str()).unwrap_or("Agent");
            agent_id_map.insert(old_id.to_string(), new_id.clone());
            agent_name_map.insert(agent_name.to_string(), new_id.clone());

            sqlx::query("INSERT INTO agents (id, company_id, name, role, title, adapter_type, adapter_config, budget_monthly_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                .bind(&new_id).bind(&company_id)
                .bind(agent_name)
                .bind(agent.get("role").and_then(|v| v.as_str()).unwrap_or("general"))
                .bind(agent.get("title").and_then(|v| v.as_str()))
                .bind(agent.get("adapter_type").and_then(|v| v.as_str()).unwrap_or("claude_local"))
                .bind(agent.get("adapter_config").and_then(|v| v.as_str()).unwrap_or("{}"))
                .bind(agent.get("budget_monthly_cents").and_then(|v| v.as_i64()).unwrap_or(0))
                .execute(pool).await.map_err(|e| e.to_string())?;
        }
    }

    // Second pass: remap reports_to (support both ID and name lookup)
    if let Some(agents) = bundle.get("agents").and_then(|v| v.as_array()) {
        for agent in agents {
            let old_id = agent.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let old_reports_to = agent.get("reports_to").and_then(|v| v.as_str()).unwrap_or("");
            if !old_reports_to.is_empty() {
                let new_id = agent_id_map.get(old_id)
                    .or_else(|| agent_name_map.get(old_id));
                let new_reports_to = agent_id_map.get(old_reports_to)
                    .or_else(|| agent_name_map.get(old_reports_to));
                if let (Some(nid), Some(nrt)) = (new_id, new_reports_to) {
                    let _ = sqlx::query("UPDATE agents SET reports_to = ? WHERE id = ?")
                        .bind(nrt).bind(nid).execute(pool).await;
                }
            }
        }
    }

    // Import config revisions
    if let Some(revisions) = bundle.get("config_revisions").and_then(|v| v.as_array()) {
        for rev in revisions {
            let new_id = Uuid::new_v4().to_string();
            let old_agent_id = rev.get("agent_id").and_then(|v| v.as_str()).unwrap_or("");
            let new_agent_id = agent_id_map.get(old_agent_id);
            if let Some(naid) = new_agent_id {
                let _ = sqlx::query("INSERT INTO agent_config_revisions (id, company_id, agent_id, source, changed_keys, before_config) VALUES (?, ?, ?, ?, ?, ?)")
                    .bind(&new_id).bind(&company_id)
                    .bind(naid)
                    .bind(rev.get("source").and_then(|v| v.as_str()).unwrap_or("import"))
                    .bind(rev.get("changed_keys").and_then(|v| v.as_str()).unwrap_or("[]"))
                    .bind(rev.get("before_config").and_then(|v| v.as_str()).unwrap_or("{}"))
                    .execute(pool).await;
            }
        }
    }

    // Import projects (map old IDs and names to new IDs)
    let mut project_name_map: HashMap<String, String> = HashMap::new();
    if let Some(projects) = bundle.get("projects").and_then(|v| v.as_array()) {
        for project in projects {
            let new_id = Uuid::new_v4().to_string();
            let project_name = project.get("name").and_then(|v| v.as_str()).unwrap_or("Project");
            project_name_map.insert(project_name.to_string(), new_id.clone());
            if let Some(old_id) = project.get("id").and_then(|v| v.as_str()) {
                project_name_map.insert(old_id.to_string(), new_id.clone());
            }
            sqlx::query("INSERT INTO projects (id, company_id, name, description) VALUES (?, ?, ?, ?)")
                .bind(&new_id).bind(&company_id)
                .bind(project_name)
                .bind(project.get("description").and_then(|v| v.as_str()))
                .execute(pool).await.map_err(|e| e.to_string())?;
        }
    }

    // Import issues (resolve assignee and project by both old-ID and name)
    if let Some(issues) = bundle.get("issues").and_then(|v| v.as_array()) {
        for (i, issue) in issues.iter().enumerate() {
            let new_id = Uuid::new_v4().to_string();
            let num = (i + 1) as i64;
            let identifier = format!("{}-{}", prefix, num);

            let assignee_id = issue.get("assignee_agent_id").and_then(|v| v.as_str())
                .and_then(|old| agent_id_map.get(old).cloned())
                .or_else(|| issue.get("assignee").and_then(|v| v.as_str())
                    .and_then(|name| agent_name_map.get(name).cloned()));

            let project_id = issue.get("project_id").and_then(|v| v.as_str())
                .and_then(|old| project_name_map.get(old).cloned())
                .or_else(|| issue.get("project").and_then(|v| v.as_str())
                    .and_then(|name| project_name_map.get(name).cloned()));

            sqlx::query("INSERT INTO issues (id, company_id, project_id, issue_number, identifier, title, status, priority, assignee_agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
                .bind(&new_id).bind(&company_id).bind(&project_id).bind(num).bind(&identifier)
                .bind(issue.get("title").and_then(|v| v.as_str()).unwrap_or("Issue"))
                .bind(issue.get("status").and_then(|v| v.as_str()).unwrap_or("backlog"))
                .bind(issue.get("priority").and_then(|v| v.as_str()).unwrap_or("medium"))
                .bind(&assignee_id)
                .execute(pool).await.map_err(|e| e.to_string())?;
        }
    }

    // Import skills (v2)
    if let Some(skills) = bundle.get("skills").and_then(|v| v.as_array()) {
        for skill in skills {
            let new_id = Uuid::new_v4().to_string();
            let skill_key = skill.get("skill_key").and_then(|v| v.as_str()).unwrap_or(&new_id);
            sqlx::query("INSERT INTO company_skills (id, company_id, skill_key, slug, name, markdown) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(&new_id).bind(&company_id)
                .bind(skill_key)
                .bind(skill.get("slug").and_then(|v| v.as_str()).unwrap_or("imported"))
                .bind(skill.get("name").and_then(|v| v.as_str()).unwrap_or("Skill"))
                .bind(skill.get("markdown").and_then(|v| v.as_str()).unwrap_or(""))
                .execute(pool).await.map_err(|e| e.to_string())?;
        }
    }

    // Import routines (v2)
    if let Some(routines) = bundle.get("routines").and_then(|v| v.as_array()) {
        for routine in routines {
            let new_id = Uuid::new_v4().to_string();
            sqlx::query("INSERT INTO routines (id, company_id, title, description, concurrency_policy, catch_up_policy) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(&new_id).bind(&company_id)
                .bind(routine.get("title").and_then(|v| v.as_str()).unwrap_or("Routine"))
                .bind(routine.get("description").and_then(|v| v.as_str()))
                .bind(routine.get("concurrency_policy").and_then(|v| v.as_str()).unwrap_or("skip"))
                .bind(routine.get("catch_up_policy").and_then(|v| v.as_str()).unwrap_or("skip"))
                .execute(pool).await.map_err(|e| e.to_string())?;
        }
    }

    // Return created company
    sqlx::query_as::<_, Company>(
        "SELECT id, name, issue_prefix, status, created_at, updated_at FROM companies WHERE id = ?"
    ).bind(&company_id).fetch_one(pool).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn import_company(pool: State<'_, DbPool>, json_data: String) -> Result<Company, String> {
    import_company_internal(&pool.0, json_data).await
}

#[tauri::command]
pub async fn import_bundled_company(
    pool: State<'_, DbPool>,
    template_name: String,
    adapter_type: Option<String>,
    adapter_config: Option<String>,
) -> Result<Company, String> {
    let json_str = match template_name.as_str() {
        "creator_business_os" => CREATOR_BUSINESS_OS,
        _ => return Err(format!("Unknown template: {}", template_name)),
    };

    // If user specified an adapter, override all agents in the template
    let json_data = if let Some(ref at) = adapter_type {
        let mut bundle: serde_json::Value = serde_json::from_str(json_str).map_err(|e| e.to_string())?;
        if let Some(agents) = bundle.get_mut("agents").and_then(|a| a.as_array_mut()) {
            let config = adapter_config.clone().unwrap_or_else(|| "{}".to_string());
            for agent in agents.iter_mut() {
                if let Some(obj) = agent.as_object_mut() {
                    obj.insert("adapter_type".to_string(), serde_json::Value::String(at.clone()));
                    obj.insert("adapter_config".to_string(), serde_json::Value::String(config.clone()));
                }
            }
        }
        serde_json::to_string(&bundle).map_err(|e| e.to_string())?
    } else {
        json_str.to_string()
    };

    import_company_internal(&pool.0, json_data).await
}

#[tauri::command]
pub async fn import_github_company(pool: State<'_, DbPool>, github_url: String) -> Result<Company, String> {
    // Parse GitHub URL -> raw content URL for company-export.json
    let parts: Vec<&str> = github_url.trim_end_matches('/').split('/').collect();
    let tree_idx = parts.iter().position(|p| *p == "tree");

    let raw_url = if let Some(idx) = tree_idx {
        if parts.len() > idx + 2 {
            let org = parts[idx - 2];
            let repo = parts[idx - 1];
            let branch = parts[idx + 1];
            let path = parts[idx + 2..].join("/");
            format!("https://raw.githubusercontent.com/{}/{}/{}/{}/company-export.json", org, repo, branch, path)
        } else {
            return Err("Invalid GitHub URL format".into());
        }
    } else {
        return Err("Expected GitHub URL with /tree/ path".into());
    };

    let json_data = reqwest::get(&raw_url).await.map_err(|e| format!("Fetch failed: {}", e))?
        .text().await.map_err(|e| format!("Read failed: {}", e))?;

    import_company_internal(&pool.0, json_data).await
}
