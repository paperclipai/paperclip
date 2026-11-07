use crate::local_runner::LocalRunnerError;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use toml_edit::{value, DocumentMut};

// Resolve on the provider host. In particular, a Daytona path must never be
// canonicalized against the controller's filesystem.
fn execution_root(cwd: &Path) -> Result<PathBuf, LocalRunnerError> {
    let root = fs::canonicalize(cwd)
        .map_err(|_| LocalRunnerError::invalid("codex_startup_trust_root_unavailable"))?;
    // Resolve Git's indirection without running project hooks or Git commands.
    for ancestor in root.ancestors() {
        let git = ancestor.join(".git");
        if git.is_dir() {
            return Ok(ancestor.to_path_buf());
        }
        if git.is_file() {
            let pointer = fs::read_to_string(&git)
                .map_err(|_| LocalRunnerError::invalid("codex_startup_trust_git_unreadable"))?;
            let directory = pointer
                .trim()
                .strip_prefix("gitdir: ")
                .ok_or_else(|| LocalRunnerError::invalid("codex_startup_trust_git_invalid"))?;
            let directory = fs::canonicalize(ancestor.join(directory))
                .map_err(|_| LocalRunnerError::invalid("codex_startup_trust_git_unavailable"))?;
            let common_file = directory.join("commondir");
            if common_file.is_file() {
                let common = fs::read_to_string(common_file).map_err(|_| {
                    LocalRunnerError::invalid("codex_startup_trust_common_unreadable")
                })?;
                let common = fs::canonicalize(directory.join(common.trim())).map_err(|_| {
                    LocalRunnerError::invalid("codex_startup_trust_common_unavailable")
                })?;
                if common.file_name().is_some_and(|name| name == ".git") {
                    return Ok(common.parent().expect(".git has a parent").to_path_buf());
                }
            }
            return Ok(ancestor.to_path_buf());
        }
    }
    Ok(root)
}

pub(crate) fn trust_startup_root(home: &Path, cwd: &Path) -> Result<(), LocalRunnerError> {
    if !home.is_absolute() || !cwd.is_absolute() {
        return Err(LocalRunnerError::invalid(
            "codex_startup_trust_requires_absolute_paths",
        ));
    }
    let root = execution_root(cwd)?;
    fs::create_dir_all(home)
        .map_err(|_| LocalRunnerError::invalid("codex_startup_trust_home_unavailable"))?;
    let path = home.join("config.toml");
    let existing = match fs::read_to_string(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => {
            return Err(LocalRunnerError::invalid(
                "codex_startup_trust_config_unreadable",
            ))
        }
    };
    let mut document = existing
        .parse::<DocumentMut>()
        .map_err(|_| LocalRunnerError::invalid("codex_startup_trust_config_invalid"))?;
    let root_key = root
        .to_str()
        .ok_or_else(|| LocalRunnerError::invalid("codex_startup_trust_non_utf8_root"))?;
    if let Some(projects) = document.get("projects") {
        let projects = projects
            .as_table_like()
            .ok_or_else(|| LocalRunnerError::invalid("codex_startup_trust_invalid_projects"))?;
        if projects
            .get(root_key)
            .is_some_and(|project| project.as_table_like().is_none())
        {
            return Err(LocalRunnerError::invalid(
                "codex_startup_trust_invalid_project",
            ));
        }
    }
    document["projects"][root_key]["trust_level"] = value("trusted");
    let temporary = home.join(format!("config.toml.{}.tmp", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options
            .open(&temporary)
            .map_err(|_| LocalRunnerError::invalid("codex_startup_trust_write_failed"))?;
        file.write_all(document.to_string().as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| LocalRunnerError::invalid("codex_startup_trust_write_failed"))?;
        fs::rename(&temporary, path)
            .map_err(|_| LocalRunnerError::invalid("codex_startup_trust_commit_failed"))
    })();
    let _ = fs::remove_file(temporary);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_project_tables_without_overwriting_configuration() {
        let temp = std::env::temp_dir().join(format!("codex-trust-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp).unwrap();
        let original = "projects = false\n";
        fs::write(temp.join("config.toml"), original).unwrap();
        assert!(trust_startup_root(&temp, &temp).is_err());
        assert_eq!(
            fs::read_to_string(temp.join("config.toml")).unwrap(),
            original
        );
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn trusts_non_git_and_worktree_roots_without_replacing_configuration() {
        let temp = std::env::temp_dir().join(format!("codex-trust-{}", uuid::Uuid::new_v4()));
        let root = temp.join("project");
        let home = temp.join("home");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("config.toml"), "model = 'test'\n# retain this comment\n[mcp_servers.test]\nurl = 'http://localhost/example'\n").unwrap();
        trust_startup_root(&home, &root).unwrap();
        trust_startup_root(&home, &root).unwrap();
        let config = fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(config.contains("# retain this comment"));
        let parsed = config.parse::<DocumentMut>().unwrap();
        assert_eq!(parsed["model"].as_str(), Some("test"));
        assert_eq!(
            parsed["projects"][fs::canonicalize(&root).unwrap().to_str().unwrap()]["trust_level"]
                .as_str(),
            Some("trusted")
        );
        let git = root.join(".git");
        let metadata = git.join("worktrees/branch");
        fs::create_dir_all(&metadata).unwrap();
        let branch = temp.join("branch");
        fs::create_dir_all(&branch).unwrap();
        fs::write(
            branch.join(".git"),
            format!("gitdir: {}", metadata.display()),
        )
        .unwrap();
        fs::write(metadata.join("commondir"), "../..").unwrap();
        assert_eq!(
            execution_root(&branch).unwrap(),
            fs::canonicalize(&root).unwrap()
        );
        trust_startup_root(&home, &branch).unwrap();
        fs::remove_dir_all(temp).unwrap();
    }
}
