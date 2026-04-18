use sqlx::SqlitePool;
use uuid::Uuid;
use std::path::PathBuf;

pub struct WorktreeConfig {
    pub branch_template: String,
    pub base_ref: String,
    pub worktree_home: PathBuf,
}

impl Default for WorktreeConfig {
    fn default() -> Self {
        let home = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("com.archonos.app")
            .join("worktrees");
        Self {
            branch_template: "{{identifier}}-{{slug}}".to_string(),
            base_ref: "main".to_string(),
            worktree_home: home,
        }
    }
}

pub struct RealizedWorkspace {
    pub workspace_id: String,
    pub cwd: String,
    pub branch_name: String,
    pub strategy: String,
    pub created: bool,
}

pub fn interpolate_branch_name(template: &str, identifier: &str, title: &str) -> String {
    let slug: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    let slug: String = slug
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let slug = if slug.len() > 40 { &slug[..40] } else { &slug };
    template
        .replace("{{identifier}}", identifier)
        .replace("{{slug}}", slug)
}

pub async fn realize_workspace(
    pool: &SqlitePool,
    company_id: &str,
    agent_id: &str,
    issue_identifier: Option<&str>,
    issue_title: Option<&str>,
    project_cwd: &str,
    config: &WorktreeConfig,
) -> Result<RealizedWorkspace, String> {
    let id = Uuid::new_v4().to_string();

    // Check if project cwd is a git repo
    let is_git = tokio::process::Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(project_cwd)
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);

    if !is_git || issue_identifier.is_none() {
        // Not a git repo or no issue — use project primary strategy
        sqlx::query(
            "INSERT INTO execution_workspaces (id, company_id, agent_id, cwd, status, strategy_type) VALUES (?, ?, ?, ?, 'active', 'project_primary')",
        )
        .bind(&id)
        .bind(company_id)
        .bind(agent_id)
        .bind(project_cwd)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

        return Ok(RealizedWorkspace {
            workspace_id: id,
            cwd: project_cwd.to_string(),
            branch_name: String::new(),
            strategy: "project_primary".to_string(),
            created: false,
        });
    }

    // Git worktree strategy
    let identifier = issue_identifier.unwrap_or("unknown");
    let title = issue_title.unwrap_or("task");
    let branch = interpolate_branch_name(&config.branch_template, identifier, title);

    std::fs::create_dir_all(&config.worktree_home).map_err(|e| e.to_string())?;
    let worktree_path = config.worktree_home.join(&branch);
    let path_str = worktree_path.to_string_lossy().to_string();

    // Detect base ref
    let base_ref = detect_base_ref(project_cwd)
        .await
        .unwrap_or_else(|| config.base_ref.clone());

    // Create worktree
    let output = tokio::process::Command::new("git")
        .args(["worktree", "add", "-b", &branch, &path_str, &base_ref])
        .current_dir(project_cwd)
        .output()
        .await
        .map_err(|e| format!("Failed to create worktree: {}", e))?;

    if !output.status.success() {
        // Branch may already exist, try without -b
        let output2 = tokio::process::Command::new("git")
            .args(["worktree", "add", &path_str, &branch])
            .current_dir(project_cwd)
            .output()
            .await
            .map_err(|e| format!("Failed to attach worktree: {}", e))?;

        if !output2.status.success() {
            return Err(format!(
                "Git worktree creation failed: {}",
                String::from_utf8_lossy(&output2.stderr)
            ));
        }
    }

    // Record in DB
    sqlx::query(
        "INSERT INTO execution_workspaces (id, company_id, agent_id, cwd, status, strategy_type, branch_name, worktree_path, base_ref) VALUES (?, ?, ?, ?, 'active', 'git_worktree', ?, ?, ?)",
    )
    .bind(&id)
    .bind(company_id)
    .bind(agent_id)
    .bind(&path_str)
    .bind(&branch)
    .bind(&path_str)
    .bind(&base_ref)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(RealizedWorkspace {
        workspace_id: id,
        cwd: path_str,
        branch_name: branch,
        strategy: "git_worktree".to_string(),
        created: true,
    })
}

pub async fn release_workspace(
    pool: &SqlitePool,
    workspace_id: &str,
    cleanup: bool,
) -> Result<(), String> {
    // Get workspace details
    let ws = sqlx::query_as::<_, (String, Option<String>, Option<String>)>(
        "SELECT cwd, strategy_type, worktree_path FROM execution_workspaces WHERE id = ?",
    )
    .bind(workspace_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    if let Some((_cwd, strategy, worktree_path)) = ws {
        if cleanup && strategy.as_deref() == Some("git_worktree") {
            if let Some(path) = worktree_path {
                // Remove git worktree
                let _ = tokio::process::Command::new("git")
                    .args(["worktree", "remove", "--force", &path])
                    .output()
                    .await;
            }
        }

        sqlx::query(
            "UPDATE execution_workspaces SET status='released', released_at=datetime('now') WHERE id=?",
        )
        .bind(workspace_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[derive(Debug, serde::Serialize)]
pub struct WorkspaceReadiness {
    pub dirty_files: Vec<String>,
    pub commits_ahead: i64,
    pub commits_behind: i64,
    pub is_clean: bool,
    pub warning: Option<String>,
}

pub async fn inspect_workspace_readiness(cwd: &str) -> Result<WorkspaceReadiness, String> {
    // Check dirty files
    let status_output = tokio::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(cwd)
        .output().await.map_err(|e| format!("git status failed: {}", e))?;

    let dirty_files: Vec<String> = String::from_utf8_lossy(&status_output.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect();

    // Check commits ahead/behind
    let rev_output = tokio::process::Command::new("git")
        .args(["rev-list", "--count", "--left-right", "HEAD...@{upstream}"])
        .current_dir(cwd)
        .output().await;

    let (ahead, behind, warning) = match rev_output {
        Ok(o) if o.status.success() => {
            let text = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let parts: Vec<&str> = text.split_whitespace().collect();
            let a = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0i64);
            let b = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0i64);
            (a, b, None)
        }
        _ => (0, 0, Some("No upstream tracking branch configured".to_string())),
    };

    let is_clean = dirty_files.is_empty() && ahead == 0;

    Ok(WorkspaceReadiness {
        dirty_files,
        commits_ahead: ahead,
        commits_behind: behind,
        is_clean,
        warning,
    })
}

async fn detect_base_ref(cwd: &str) -> Option<String> {
    // Try refs/remotes/origin/HEAD
    let output = tokio::process::Command::new("git")
        .args(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"])
        .current_dir(cwd)
        .output()
        .await
        .ok()?;

    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Some(branch.replace("origin/", ""));
    }

    // Try main, then master
    for candidate in &["main", "master"] {
        let output = tokio::process::Command::new("git")
            .args([
                "rev-parse",
                "--verify",
                &format!("refs/heads/{}", candidate),
            ])
            .current_dir(cwd)
            .output()
            .await
            .ok()?;
        if output.status.success() {
            return Some(candidate.to_string());
        }
    }

    None
}
