use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use notify::{Watcher, RecursiveMode, Event as NotifyEvent};
use sqlx::SqlitePool;
use uuid::Uuid;

pub struct FileWatcherService {
    watchers: Arc<Mutex<HashMap<String, notify::RecommendedWatcher>>>,
}

impl FileWatcherService {
    pub fn new() -> Self {
        Self { watchers: Arc::new(Mutex::new(HashMap::new())) }
    }

    pub async fn watch_path(
        &self,
        rule_id: &str,
        path: &str,
        agent_id: &str,
        company_id: &str,
        pool: SqlitePool,
    ) -> Result<(), String> {
        let aid = agent_id.to_string();
        let cid = company_id.to_string();
        let pool_clone = pool.clone();
        let rid = rule_id.to_string();

        let mut watcher = notify::recommended_watcher(move |res: Result<NotifyEvent, notify::Error>| {
            if let Ok(event) = res {
                if event.kind.is_create() || event.kind.is_modify() {
                    let pool = pool_clone.clone();
                    let aid = aid.clone();
                    let cid = cid.clone();
                    let rid = rid.clone();
                    tokio::spawn(async move {
                        let wakeup_id = Uuid::new_v4().to_string();
                        let _ = sqlx::query(
                            "INSERT INTO agent_wakeup_requests (id, company_id, agent_id, source, reason, payload) VALUES (?, ?, ?, 'automation', 'file_changed', ?)"
                        ).bind(&wakeup_id).bind(&cid).bind(&aid).bind(&serde_json::json!({"rule_id": rid}).to_string())
                            .execute(&pool).await;

                        let _ = sqlx::query("UPDATE automation_rules SET last_triggered_at=datetime('now') WHERE id=?")
                            .bind(&rid).execute(&pool).await;
                    });
                }
            }
        }).map_err(|e| format!("Failed to create watcher: {}", e))?;

        watcher.watch(std::path::Path::new(path), RecursiveMode::Recursive)
            .map_err(|e| format!("Failed to watch path: {}", e))?;

        self.watchers.lock().await.insert(rule_id.to_string(), watcher);
        Ok(())
    }

    pub async fn unwatch(&self, rule_id: &str) {
        self.watchers.lock().await.remove(rule_id);
    }

    pub async fn initialize_from_db(&self, pool: &SqlitePool) {
        let rules = sqlx::query_as::<_, (String, String, String, String)>(
            "SELECT ar.id, json_extract(ar.trigger_config, '$.path'), json_extract(ar.action_config, '$.agent_id'), ar.company_id FROM automation_rules ar WHERE ar.enabled = 1 AND ar.trigger_type = 'file_change'"
        ).fetch_all(pool).await.unwrap_or_default();

        for (id, path, agent_id, company_id) in rules {
            if let Err(e) = self.watch_path(&id, &path, &agent_id, &company_id, pool.clone()).await {
                eprintln!("[file_watcher] Failed to start watcher for rule {}: {}", id, e);
            }
        }
    }
}
