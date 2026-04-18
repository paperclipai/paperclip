use sqlx::SqlitePool;
use std::path::PathBuf;
use uuid::Uuid;

fn get_skills_runtime_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.archonos.app")
        .join("skills")
        .join("__runtime__")
}

pub async fn materialize_skills_for_run(
    pool: &SqlitePool,
    agent_id: &str,
    company_id: &str,
) -> Option<String> {
    // Query skills attached to this agent
    let skills = sqlx::query_as::<_, (String, String, String)>(
        "SELECT cs.slug, cs.name, cs.markdown FROM company_skills cs JOIN agent_skills ags ON cs.id = ags.skill_id WHERE ags.agent_id = ? AND ags.company_id = ?",
    )
    .bind(agent_id)
    .bind(company_id)
    .fetch_all(pool)
    .await
    .ok()?;

    if skills.is_empty() {
        return None;
    }

    // Create temp directory for this run
    let run_dir = get_skills_runtime_dir().join(Uuid::new_v4().to_string());
    let skills_subdir = run_dir.join(".claude").join("skills");
    std::fs::create_dir_all(&skills_subdir).ok()?;

    // Write each skill as a markdown file
    for (slug, _name, markdown) in &skills {
        let skill_file = skills_subdir.join(format!("{}.md", slug));
        std::fs::write(&skill_file, markdown).ok()?;
    }

    Some(run_dir.to_string_lossy().to_string())
}

pub fn cleanup_skills_dir(dir_path: &str) {
    let _ = std::fs::remove_dir_all(dir_path);
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct DiscoveredSkill {
    pub name: String,
    pub slug: String,
    pub markdown: String,
    pub source_path: String,
}

const SCAN_ROOTS: &[&str] = &[
    "skills",
    ".claude/skills",
    ".paperclip/skills",
    ".config/skills",
    "tools/skills",
];

pub fn scan_project_skills(cwd: &str) -> Vec<DiscoveredSkill> {
    let base = std::path::PathBuf::from(cwd);
    let mut found = Vec::new();

    for root in SCAN_ROOTS {
        let dir = base.join(root);
        if !dir.is_dir() { continue; }
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if !entry.path().is_dir() { continue; }
                let skill_md = entry.path().join("SKILL.md");
                if skill_md.is_file() {
                    if let Ok(content) = std::fs::read_to_string(&skill_md) {
                        let name = entry.file_name().to_string_lossy().to_string();
                        let slug = name.to_lowercase().replace(' ', "-");
                        found.push(DiscoveredSkill {
                            name: name.clone(),
                            slug,
                            markdown: content,
                            source_path: skill_md.to_string_lossy().to_string(),
                        });
                    }
                }
            }
        }
    }

    // Also check for a root-level SKILL.md
    let root_skill = base.join("SKILL.md");
    if root_skill.is_file() {
        if let Ok(content) = std::fs::read_to_string(&root_skill) {
            let name = base.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "project".to_string());
            found.push(DiscoveredSkill {
                name: name.clone(),
                slug: name.to_lowercase().replace(' ', "-"),
                markdown: content,
                source_path: root_skill.to_string_lossy().to_string(),
            });
        }
    }

    found
}

pub async fn import_github_skill(url: &str) -> Result<DiscoveredSkill, String> {
    // Parse GitHub URL: https://github.com/{org}/{repo}/tree/{branch}/{path}
    let url_trimmed = url.trim_end_matches('/');
    let parts: Vec<&str> = url_trimmed.split('/').collect();

    // Find "tree" index to split org/repo from branch/path
    let tree_idx = parts.iter().position(|p| *p == "tree")
        .ok_or("Expected GitHub URL format: https://github.com/{org}/{repo}/tree/{branch}/{path}")?;

    if parts.len() < tree_idx + 3 {
        return Err("URL too short — need at least org/repo/tree/branch/path".into());
    }

    let org = parts[tree_idx - 2];
    let repo = parts[tree_idx - 1];
    let branch = parts[tree_idx + 1];
    let path = parts[tree_idx + 2..].join("/");

    // Fetch SKILL.md from raw GitHub content
    let raw_url = format!(
        "https://raw.githubusercontent.com/{}/{}/{}/{}/SKILL.md",
        org, repo, branch, path
    );

    let response = reqwest::get(&raw_url).await.map_err(|e| format!("HTTP error: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("SKILL.md not found at {} (HTTP {})", raw_url, response.status()));
    }

    let content = response.text().await.map_err(|e| format!("Read error: {}", e))?;
    let name = path.split('/').last().unwrap_or("skill").to_string();
    let slug = name.to_lowercase().replace(' ', "-");

    Ok(DiscoveredSkill {
        name,
        slug,
        markdown: content,
        source_path: url.to_string(),
    })
}
