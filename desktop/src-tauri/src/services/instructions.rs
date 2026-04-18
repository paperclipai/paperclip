use std::path::PathBuf;

const DEFAULT_AGENTS_MD: &str = r#"# Agent Instructions

You are an AI agent managed by ArchonOS. Your behavior is governed by these instructions.

## Core Principles
- Complete tasks thoroughly and accurately
- Report progress through comments on issues
- Follow the project's coding conventions
- Ask for clarification when requirements are ambiguous

## Communication
- Use issue comments to provide updates
- Report blockers or questions promptly
- Summarize what you accomplished when finishing a task

## Code Quality
- Write clean, well-tested code
- Follow existing patterns in the codebase
- Include appropriate error handling
"#;

fn get_instructions_dir(company_id: &str, agent_id: &str) -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.archonos.app")
        .join("companies")
        .join(company_id)
        .join("agents")
        .join(agent_id)
        .join("instructions")
}

pub fn ensure_default_instructions(company_id: &str, agent_id: &str) -> PathBuf {
    let dir = get_instructions_dir(company_id, agent_id);
    let agents_md = dir.join("AGENTS.md");
    if !agents_md.exists() {
        std::fs::create_dir_all(&dir).ok();
        std::fs::write(&agents_md, DEFAULT_AGENTS_MD).ok();
    }
    agents_md
}

pub fn resolve_for_run(
    adapter_config: &serde_json::Value,
    company_id: &str,
    agent_id: &str,
    is_session_resume: bool,
) -> Option<String> {
    // Skip instructions on session resume (Claude maintains cached instructions)
    if is_session_resume {
        return None;
    }

    // Check instructions mode from agent config
    let mode = adapter_config.get("instructionsMode")
        .and_then(|v| v.as_str())
        .unwrap_or("managed");

    match mode {
        "external" => {
            // Use external path from config
            adapter_config.get("instructionsPath")
                .and_then(|v| v.as_str())
                .map(String::from)
        }
        _ => {
            // Managed mode: ensure defaults exist and return path
            let path = ensure_default_instructions(company_id, agent_id);
            Some(path.to_string_lossy().to_string())
        }
    }
}

pub fn list_files(company_id: &str, agent_id: &str) -> Vec<String> {
    let dir = get_instructions_dir(company_id, agent_id);
    if !dir.is_dir() { return vec![]; }
    std::fs::read_dir(&dir)
        .map(|entries| entries.flatten()
            .filter(|e| e.path().is_file())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect())
        .unwrap_or_default()
}

pub fn read_instructions(company_id: &str, agent_id: &str) -> Result<String, String> {
    let path = ensure_default_instructions(company_id, agent_id);
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

pub fn write_instructions(company_id: &str, agent_id: &str, content: &str) -> Result<(), String> {
    let dir = get_instructions_dir(company_id, agent_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("AGENTS.md");
    std::fs::write(&path, content).map_err(|e| e.to_string())
}
