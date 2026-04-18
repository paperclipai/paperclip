use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

#[derive(Debug, Serialize, Deserialize, Clone, FromRow)]
pub struct Goal {
    pub id: String,
    pub company_id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub level: String,
    pub status: String,
    pub owner_agent_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct GoalNode {
    #[serde(flatten)]
    pub goal: Goal,
    pub children: Vec<GoalNode>,
}

#[derive(Debug, Deserialize)]
pub struct CreateGoalInput {
    pub title: String,
    pub description: Option<String>,
    pub level: Option<String>,
    pub parent_id: Option<String>,
    pub owner_agent_id: Option<String>,
}

const GOAL_SELECT: &str = "SELECT id, company_id, parent_id, title, description, level, status, owner_agent_id, created_at, updated_at FROM goals";

#[tauri::command]
pub async fn list_goals(pool: State<'_, DbPool>, company_id: String) -> Result<Vec<GoalNode>, String> {
    let p = &pool.0;
    let goals: Vec<Goal> = sqlx::query_as::<_, Goal>(&format!("{} WHERE company_id = ? ORDER BY created_at", GOAL_SELECT))
        .bind(&company_id).fetch_all(p).await.map_err(|e| e.to_string())?;

    Ok(build_goal_tree(&goals))
}

#[tauri::command]
pub async fn create_goal(pool: State<'_, DbPool>, company_id: String, data: CreateGoalInput) -> Result<Goal, String> {
    let p = &pool.0;
    let id = Uuid::new_v4().to_string();
    let level = data.level.unwrap_or_else(|| "task".to_string());
    sqlx::query("INSERT INTO goals (id, company_id, parent_id, title, description, level, owner_agent_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(&id).bind(&company_id).bind(&data.parent_id).bind(&data.title)
        .bind(&data.description).bind(&level).bind(&data.owner_agent_id)
        .execute(p).await.map_err(|e| e.to_string())?;

    sqlx::query_as::<_, Goal>(&format!("{} WHERE id = ?", GOAL_SELECT))
        .bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_goal(pool: State<'_, DbPool>, id: String, title: Option<String>, status: Option<String>) -> Result<Goal, String> {
    let p = &pool.0;

    let existing = sqlx::query_as::<_, Goal>(&format!("{} WHERE id = ?", GOAL_SELECT))
        .bind(&id).fetch_optional(p).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "Goal not found".to_string())?;

    let t = title.unwrap_or(existing.title);
    let s = status.unwrap_or(existing.status);
    sqlx::query("UPDATE goals SET title=?, status=?, updated_at=datetime('now') WHERE id=?")
        .bind(&t).bind(&s).bind(&id).execute(p).await.map_err(|e| e.to_string())?;

    sqlx::query_as::<_, Goal>(&format!("{} WHERE id = ?", GOAL_SELECT))
        .bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_goal(pool: State<'_, DbPool>, id: String) -> Result<(), String> {
    let p = &pool.0;
    sqlx::query("DELETE FROM goals WHERE id = ?").bind(&id).execute(p).await.map_err(|e| e.to_string())?;
    Ok(())
}

fn build_goal_tree(goals: &[Goal]) -> Vec<GoalNode> {
    goals.iter()
        .filter(|g| g.parent_id.is_none())
        .map(|root| build_goal_node(root, goals))
        .collect()
}

fn build_goal_node(goal: &Goal, all: &[Goal]) -> GoalNode {
    let children = all.iter()
        .filter(|g| g.parent_id.as_deref() == Some(&goal.id))
        .map(|child| build_goal_node(child, all))
        .collect();
    GoalNode { goal: goal.clone(), children }
}
