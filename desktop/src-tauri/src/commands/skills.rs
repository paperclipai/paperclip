use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

#[derive(Debug, Serialize, Deserialize, Clone, FromRow)]
pub struct CompanySkill {
    pub id: String,
    pub company_id: String,
    pub skill_key: String,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub markdown: String,
    pub source_type: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateSkillInput {
    pub name: String,
    pub slug: Option<String>,
    pub description: Option<String>,
    pub markdown: String,
}

#[tauri::command]
pub async fn list_company_skills(
    pool: State<'_, DbPool>,
    company_id: String,
) -> Result<Vec<CompanySkill>, String> {
    let p = &pool.0;
    sqlx::query_as::<_, CompanySkill>(
        "SELECT id, company_id, skill_key, slug, name, description, markdown, source_type, created_at, updated_at FROM company_skills WHERE company_id = ? ORDER BY name",
    )
    .bind(&company_id)
    .fetch_all(p)
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_company_skill(
    pool: State<'_, DbPool>,
    company_id: String,
    data: CreateSkillInput,
) -> Result<CompanySkill, String> {
    let p = &pool.0;
    let id = Uuid::new_v4().to_string();
    let slug = data
        .slug
        .unwrap_or_else(|| data.name.to_lowercase().replace(' ', "-"));
    let skill_key = format!("{}/{}", company_id, slug);

    sqlx::query(
        "INSERT INTO company_skills (id, company_id, skill_key, slug, name, description, markdown) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&company_id)
    .bind(&skill_key)
    .bind(&slug)
    .bind(&data.name)
    .bind(&data.description)
    .bind(&data.markdown)
    .execute(p)
    .await
    .map_err(|e| e.to_string())?;

    sqlx::query_as::<_, CompanySkill>(
        "SELECT id, company_id, skill_key, slug, name, description, markdown, source_type, created_at, updated_at FROM company_skills WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(p)
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_company_skill(pool: State<'_, DbPool>, id: String) -> Result<(), String> {
    let p = &pool.0;
    sqlx::query("DELETE FROM agent_skills WHERE skill_id = ?")
        .bind(&id)
        .execute(p)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM company_skills WHERE id = ?")
        .bind(&id)
        .execute(p)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn attach_skill_to_agent(
    pool: State<'_, DbPool>,
    company_id: String,
    agent_id: String,
    skill_id: String,
) -> Result<(), String> {
    let p = &pool.0;
    sqlx::query(
        "INSERT OR IGNORE INTO agent_skills (agent_id, skill_id, company_id) VALUES (?, ?, ?)",
    )
    .bind(&agent_id)
    .bind(&skill_id)
    .bind(&company_id)
    .execute(p)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn detach_skill_from_agent(
    pool: State<'_, DbPool>,
    agent_id: String,
    skill_id: String,
) -> Result<(), String> {
    let p = &pool.0;
    sqlx::query("DELETE FROM agent_skills WHERE agent_id = ? AND skill_id = ?")
        .bind(&agent_id)
        .bind(&skill_id)
        .execute(p)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_agent_skills(
    pool: State<'_, DbPool>,
    agent_id: String,
) -> Result<Vec<CompanySkill>, String> {
    let p = &pool.0;
    sqlx::query_as::<_, CompanySkill>(
        "SELECT cs.id, cs.company_id, cs.skill_key, cs.slug, cs.name, cs.description, cs.markdown, cs.source_type, cs.created_at, cs.updated_at FROM company_skills cs JOIN agent_skills ags ON cs.id = ags.skill_id WHERE ags.agent_id = ? ORDER BY cs.name",
    )
    .bind(&agent_id)
    .fetch_all(p)
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn scan_skills(cwd: String) -> Result<Vec<crate::services::skills::DiscoveredSkill>, String> {
    Ok(crate::services::skills::scan_project_skills(&cwd))
}

#[tauri::command]
pub async fn import_discovered_skill(
    pool: State<'_, DbPool>,
    company_id: String,
    name: String,
    slug: String,
    markdown: String,
) -> Result<CompanySkill, String> {
    let p = &pool.0;
    let id = Uuid::new_v4().to_string();
    let skill_key = format!("{}/{}", company_id, slug);

    sqlx::query(
        "INSERT INTO company_skills (id, company_id, skill_key, slug, name, markdown, source_type) VALUES (?, ?, ?, ?, ?, ?, 'discovered')"
    ).bind(&id).bind(&company_id).bind(&skill_key).bind(&slug).bind(&name).bind(&markdown)
        .execute(p).await.map_err(|e| e.to_string())?;

    sqlx::query_as::<_, CompanySkill>(
        "SELECT id, company_id, skill_key, slug, name, description, markdown, source_type, created_at, updated_at FROM company_skills WHERE id = ?"
    ).bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn import_skill_from_github(
    pool: State<'_, DbPool>,
    company_id: String,
    github_url: String,
) -> Result<CompanySkill, String> {
    let discovered = crate::services::skills::import_github_skill(&github_url).await?;

    let p = &pool.0;
    let id = Uuid::new_v4().to_string();
    let skill_key = format!("{}/{}", company_id, discovered.slug);

    sqlx::query(
        "INSERT INTO company_skills (id, company_id, skill_key, slug, name, markdown, source_type, metadata) VALUES (?, ?, ?, ?, ?, ?, 'github', ?)"
    )
    .bind(&id).bind(&company_id).bind(&skill_key).bind(&discovered.slug)
    .bind(&discovered.name).bind(&discovered.markdown).bind(&github_url)
    .execute(p).await.map_err(|e| e.to_string())?;

    sqlx::query_as::<_, CompanySkill>(
        "SELECT id, company_id, skill_key, slug, name, description, markdown, source_type, created_at, updated_at FROM company_skills WHERE id = ?"
    ).bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}
