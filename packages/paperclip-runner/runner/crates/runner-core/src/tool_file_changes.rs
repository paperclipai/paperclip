//! Bounded per-edit file changes for `paperclip.tool.execution.v1`
//! (`fileChanges`) and the Codex whole-turn diff projection
//! (`paperclip.workspace.diff.v1`). Paths are workspace-relative and every
//! patch passes through the shared secret redaction before it is emitted.

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};

use crate::durable::redact_sensitive_text_values;

const MAX_FILE_CHANGES: usize = 32;
/// UTF-8 bytes of one file's patch (also within the schema's 32768-character bound).
const MAX_FILE_DIFF_BYTES: usize = 32 * 1024;
const MAX_TURN_FILES: usize = 2_000;
const MAX_TURN_FILE_DIFF_BYTES: usize = 64 * 1024;
/// Serialized patch bytes in one turn snapshot, below the 256 KiB durable
/// display payload bound with room for the file metadata.
const MAX_TURN_DIFF_TOTAL_BYTES: usize = 160 * 1024;
const MAX_PATH_CHARS: usize = 1_024;
/// Serialized patch bytes for one edit call, below the durable display payload
/// bound with room for tool output and the other fields.
const MAX_CALL_DIFF_BYTES: usize = 96 * 1024;

/// Bytes a string takes once serialized as JSON (escapes included).
fn serialized_len(value: &str) -> usize {
    serde_json::to_string(value).map_or(usize::MAX, |encoded| encoded.len())
}

/// Keep whole patches in order until the call budget runs out; later files keep
/// their counts and report a shortened (absent) patch.
fn within_call_budget(mut files: Vec<Value>) -> Vec<Value> {
    let mut budget = MAX_CALL_DIFF_BYTES;
    for file in &mut files {
        let size = file["diff"].as_str().map_or(0, serialized_len);
        if size > budget {
            file["diff"] = Value::Null;
            file["diffTruncated"] = Value::Bool(true);
        } else {
            budget -= size;
        }
    }
    files
}

static TURN_DIFF_REVISION: AtomicU64 = AtomicU64::new(0);

fn normalize_relative(candidate: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for part in candidate.split('/') {
        match part {
            "" | "." => continue,
            ".." => return None,
            part => parts.push(part),
        }
    }
    let joined = parts.join("/");
    (!joined.is_empty() && joined.chars().count() <= MAX_PATH_CHARS).then_some(joined)
}

/// Make a provider path workspace-relative. Absolute paths must sit under the
/// working directory; anything that escapes it is dropped.
pub fn workspace_relative_path(value: &str, cwd: Option<&str>) -> Option<String> {
    let value = value
        .trim()
        .trim_start_matches("file://")
        .replace('\\', "/");
    if value.is_empty() {
        return None;
    }
    let windows_drive =
        value.len() > 2 && value.as_bytes()[1] == b':' && value.as_bytes()[0].is_ascii_alphabetic();
    if value.starts_with('/') || windows_drive {
        let root = cwd?.replace('\\', "/");
        let root = root.trim_end_matches('/');
        let rest = value.strip_prefix(root)?;
        if !rest.starts_with('/') {
            return None;
        }
        return normalize_relative(rest);
    }
    normalize_relative(&value)
}

fn count_changes(diff: &str) -> (u64, u64) {
    let mut additions = 0;
    let mut deletions = 0;
    let mut in_hunk = false;
    for line in diff.lines() {
        if line.starts_with("@@") {
            in_hunk = true;
            continue;
        }
        if !in_hunk && (line.starts_with("+++ ") || line.starts_with("--- ")) {
            continue;
        }
        if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        }
    }
    (additions, deletions)
}

/// Redact, then bound at a line boundary. Returns the patch and whether it was cut.
fn bounded_diff(diff: &str, max_bytes: usize) -> (String, bool) {
    let redacted = redact_sensitive_text_values(diff);
    if redacted.len() <= max_bytes {
        return (redacted, false);
    }
    let mut end = max_bytes;
    while !redacted.is_char_boundary(end) {
        end -= 1;
    }
    let prefix = &redacted[..end];
    let cut = prefix.rfind('\n').unwrap_or(prefix.len());
    (prefix[..cut].to_owned(), true)
}

fn one_sided_hunk(content: &str, added: bool) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let marker = if added { '+' } else { '-' };
    let header = if added {
        format!("@@ -0,0 +1,{} @@", lines.len())
    } else {
        format!("@@ -1,{} +0,0 @@", lines.len())
    };
    let mut out = header;
    for line in lines {
        out.push('\n');
        out.push(marker);
        out.push_str(line);
    }
    out.push('\n');
    out
}

fn file_change(
    path: String,
    operation: &str,
    previous_path: Option<String>,
    diff: Option<&str>,
) -> Value {
    let (additions, deletions) = diff.map(count_changes).unwrap_or((0, 0));
    let (diff, truncated) = match diff {
        Some(diff) => {
            let (bounded, truncated) = bounded_diff(diff, MAX_FILE_DIFF_BYTES);
            (Value::String(bounded), truncated)
        }
        None => (Value::Null, false),
    };
    json!({
        "path": path,
        "operation": operation,
        "previousPath": previous_path,
        "additions": additions,
        "deletions": deletions,
        "diff": diff,
        "diffTruncated": truncated,
    })
}

/// `fileChanges` for a Codex `fileChange` item (`changes[]` of `{ path, kind, diff }`).
/// Codex reports an added or deleted file's content rather than a patch.
pub fn codex_file_changes(changes: Option<&Value>, cwd: Option<&str>) -> Option<Value> {
    let files: Vec<Value> = changes?
        .as_array()?
        .iter()
        .take(MAX_FILE_CHANGES)
        .filter_map(|change| {
            let path = workspace_relative_path(change.get("path")?.as_str()?, cwd)?;
            let kind = change.get("kind");
            let kind_type = kind
                .and_then(|kind| {
                    kind.get("type")
                        .and_then(Value::as_str)
                        .or_else(|| kind.as_str())
                })
                .unwrap_or("update")
                .to_ascii_lowercase();
            let move_path = kind
                .and_then(|kind| kind.get("move_path").or_else(|| kind.get("movePath")))
                .and_then(Value::as_str)
                .and_then(|value| workspace_relative_path(value, cwd));
            let raw = change.get("diff").and_then(Value::as_str);
            let operation = if move_path.is_some() {
                "rename"
            } else if kind_type.contains("add") {
                "create"
            } else if kind_type.contains("delete") {
                "delete"
            } else {
                "modify"
            };
            let diff = raw.map(|raw| {
                let has_hunk = raw.lines().any(|line| line.starts_with("@@ "));
                match operation {
                    "create" if !has_hunk => one_sided_hunk(raw, true),
                    "delete" if !has_hunk => one_sided_hunk(raw, false),
                    _ => raw.to_owned(),
                }
            });
            Some(match move_path {
                Some(target) => file_change(target, operation, Some(path), diff.as_deref()),
                None => file_change(path, operation, None, diff.as_deref()),
            })
        })
        .collect();
    (!files.is_empty()).then(|| Value::Array(within_call_budget(files)))
}

/// Re-validate `fileChanges` computed by the ACPX sidecar before they cross
/// into a canonical event: closed shape, safe paths, bounded redacted patches.
pub fn sanitize_file_changes(value: Option<&Value>) -> Option<Value> {
    let files: Vec<Value> = value?
        .as_array()?
        .iter()
        .take(MAX_FILE_CHANGES)
        .filter_map(|change| {
            let path = workspace_relative_path(change.get("path")?.as_str()?, None)?;
            let operation = match change.get("operation")?.as_str()? {
                operation @ ("create" | "modify" | "delete" | "rename") => operation,
                _ => return None,
            };
            let previous_path = change
                .get("previousPath")
                .and_then(Value::as_str)
                .and_then(|value| workspace_relative_path(value, None));
            let diff = change.get("diff").and_then(Value::as_str);
            let mut sanitized = file_change(path, operation, previous_path, diff);
            if change.get("diffTruncated").and_then(Value::as_bool) == Some(true) {
                sanitized["diffTruncated"] = Value::Bool(true);
            }
            // Counts from the sidecar cover the whole patch even when it was bounded.
            for key in ["additions", "deletions"] {
                if let Some(count) = change.get(key).and_then(Value::as_u64) {
                    sanitized[key] = json!(count);
                }
            }
            Some(sanitized)
        })
        .collect();
    (!files.is_empty()).then(|| Value::Array(within_call_budget(files)))
}

fn diff_header_path(value: &str) -> Option<&str> {
    let value = value.trim();
    if value == "/dev/null" {
        return None;
    }
    Some(
        value
            .strip_prefix("a/")
            .or_else(|| value.strip_prefix("b/"))
            .unwrap_or(value),
    )
}

/// Codex writes absolute paths into the turn diff unless cwd-relative diffs
/// are enabled, so `a//w/repo/x` arrives as `/w/repo/x` or `w/repo/x`.
fn turn_diff_path(raw: &str, cwd: Option<&str>) -> Option<String> {
    if let Some(root) = cwd.map(|root| root.trim_end_matches('/')) {
        let rooted = if raw.starts_with('/') {
            raw.to_owned()
        } else {
            format!("/{raw}")
        };
        if root.starts_with('/') && rooted.starts_with(&format!("{root}/")) {
            return workspace_relative_path(&rooted, cwd);
        }
    }
    workspace_relative_path(raw, cwd)
}

/// Project a Codex `turn/diff/updated` unified diff into a
/// `paperclip.workspace.diff.v1` snapshot for the turn's change set.
pub fn codex_turn_diff_snapshot(turn_id: &str, diff: &str, cwd: Option<&str>) -> Value {
    struct File {
        lines: Vec<String>,
        old: Option<String>,
        new: Option<String>,
        rename_from: Option<String>,
        rename_to: Option<String>,
        binary: bool,
        seen_old: bool,
        seen_new: bool,
    }
    let mut files: Vec<File> = Vec::new();
    for line in diff.lines() {
        if line.starts_with("diff --git ") {
            files.push(File {
                lines: Vec::new(),
                old: None,
                new: None,
                rename_from: None,
                rename_to: None,
                binary: false,
                seen_old: false,
                seen_new: false,
            });
            if let Some(file) = files.last_mut() {
                // Fallback paths from `diff --git a/x b/y` when ---/+++ are absent.
                if let Some(rest) = line.strip_prefix("diff --git ") {
                    if let Some((left, right)) = rest.split_once(" b/") {
                        file.old = diff_header_path(left).map(str::to_owned);
                        file.new = Some(right.to_owned());
                    }
                }
            }
            continue;
        }
        let Some(file) = files.last_mut() else {
            continue;
        };
        if let Some(path) = line.strip_prefix("--- ") {
            if !file.seen_old && file.lines.iter().all(|line| !line.starts_with("@@")) {
                file.old = diff_header_path(path).map(str::to_owned);
                file.seen_old = true;
                continue;
            }
        }
        if let Some(path) = line.strip_prefix("+++ ") {
            if !file.seen_new && file.lines.iter().all(|line| !line.starts_with("@@")) {
                file.new = diff_header_path(path).map(str::to_owned);
                file.seen_new = true;
                continue;
            }
        }
        if let Some(path) = line.strip_prefix("rename from ") {
            file.rename_from = Some(path.to_owned());
        } else if let Some(path) = line.strip_prefix("rename to ") {
            file.rename_to = Some(path.to_owned());
        } else if line.starts_with("Binary files ") || line == "GIT binary patch" {
            file.binary = true;
        }
        file.lines.push(line.to_owned());
    }
    let mut budget = MAX_TURN_DIFF_TOTAL_BYTES;
    let projected: Vec<Value> = files
        .into_iter()
        .filter_map(|file| {
            let created = file.seen_old && file.old.is_none();
            let deleted = file.seen_new && file.new.is_none();
            let raw_path = file
                .rename_to
                .clone()
                .or(file.new.clone())
                .or(file.old.clone())?;
            let path = turn_diff_path(&raw_path, cwd)?;
            let previous_path = file
                .rename_from
                .as_deref()
                .and_then(|value| turn_diff_path(value, cwd));
            let operation = if previous_path.is_some() {
                "rename"
            } else if created {
                "create"
            } else if deleted {
                "delete"
            } else {
                "modify"
            };
            let body = file
                .lines
                .iter()
                .skip_while(|line| !line.starts_with("@@"))
                .cloned()
                .collect::<Vec<_>>()
                .join("\n");
            let (additions, deletions) = count_changes(&body);
            let diff = if file.binary || body.is_empty() {
                Value::Null
            } else {
                let (bounded, _) = bounded_diff(&format!("{body}\n"), MAX_TURN_FILE_DIFF_BYTES);
                let size = serialized_len(&bounded);
                if size > budget {
                    Value::Null
                } else {
                    budget -= size;
                    Value::String(bounded)
                }
            };
            Some(json!({
                "path": path,
                "operation": operation,
                "previousPath": previous_path,
                "additions": if file.binary { Value::Null } else { json!(additions) },
                "deletions": if file.binary { Value::Null } else { json!(deletions) },
                "binary": file.binary,
                "diff": diff,
            }))
        })
        .take(MAX_TURN_FILES)
        .collect();
    let unknown = projected.iter().any(|file| file["additions"].is_null());
    let sum = |key: &str| -> Value {
        if unknown {
            Value::Null
        } else {
            json!(projected
                .iter()
                .filter_map(|file| file[key].as_u64())
                .sum::<u64>())
        }
    };
    json!({
        "schema": "paperclip.workspace.diff.v1",
        "changeSetId": format!("{turn_id}:workspace"),
        "revision": TURN_DIFF_REVISION.fetch_add(1, Ordering::Relaxed) + 1,
        "source": "harness_reported",
        "complete": false,
        "totals": { "files": projected.len(), "additions": sum("additions"), "deletions": sum("deletions") },
        "files": projected,
        "patchArtifactRef": Value::Null,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relativizes_only_paths_inside_the_workspace() {
        assert_eq!(
            workspace_relative_path("/w/repo/src/a.ts", Some("/w/repo")).as_deref(),
            Some("src/a.ts")
        );
        assert_eq!(
            workspace_relative_path("src/./a.ts", None).as_deref(),
            Some("src/a.ts")
        );
        assert_eq!(
            workspace_relative_path("/w/repository/a.ts", Some("/w/repo")),
            None
        );
        assert_eq!(
            workspace_relative_path("/etc/passwd", Some("/w/repo")),
            None
        );
        assert_eq!(workspace_relative_path("../x", None), None);
    }

    #[test]
    fn maps_codex_changes_with_counts_and_one_sided_new_files() {
        let changes = codex_file_changes(
            Some(&json!([
                {"path": "/w/repo/a.js", "kind": {"type": "update", "move_path": null}, "diff": "@@ -1 +1 @@\n-a\n+b\n"},
                {"path": "b.js", "kind": {"type": "add"}, "diff": "one\ntwo\n"},
                {"path": "/elsewhere/c.js", "kind": {"type": "add"}, "diff": "x"}
            ])),
            Some("/w/repo"),
        )
        .unwrap();
        assert_eq!(changes.as_array().unwrap().len(), 2);
        assert_eq!(changes[0]["path"], "a.js");
        assert_eq!(changes[0]["additions"], 1);
        assert_eq!(changes[0]["deletions"], 1);
        assert_eq!(changes[1]["operation"], "create");
        assert_eq!(changes[1]["diff"], "@@ -0,0 +1,2 @@\n+one\n+two\n");
    }

    #[test]
    fn sanitizes_sidecar_changes_and_bounds_patches() {
        let big = format!("@@ -0,0 +1,5000 @@\n{}", "+line of text\n".repeat(5_000));
        let changes = sanitize_file_changes(Some(&json!([
            {"path": "ok.txt", "operation": "create", "previousPath": null, "additions": 5000, "deletions": 0, "diff": big, "diffTruncated": false},
            {"path": "/abs.txt", "operation": "modify", "diff": ""},
            {"path": "x.txt", "operation": "explode", "diff": ""}
        ])))
        .unwrap();
        assert_eq!(changes.as_array().unwrap().len(), 1);
        assert_eq!(changes[0]["additions"], 5000);
        assert_eq!(changes[0]["diffTruncated"], true);
        assert!(changes[0]["diff"].as_str().unwrap().len() <= MAX_FILE_DIFF_BYTES);
    }

    #[test]
    fn budgets_serialized_bytes_and_keeps_counts() {
        let wide = format!(
            "@@ -0,0 +1,3000 @@\n{}",
            "+中文内容中文内容\n".repeat(3_000)
        );
        let change = |path: &str| {
            json!({"path": path, "operation": "create", "previousPath": null,
            "additions": 3000, "deletions": 0, "diff": wide, "diffTruncated": false})
        };
        let changes = sanitize_file_changes(Some(&json!([
            change("a"),
            change("b"),
            change("c"),
            change("d")
        ])))
        .unwrap();
        let total: usize = changes
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|file| file["diff"].as_str().map(serialized_len))
            .sum();
        assert!(total <= MAX_CALL_DIFF_BYTES);
        assert!(changes
            .as_array()
            .unwrap()
            .iter()
            .all(|file| file["additions"] == 3000));
        assert!(changes[3]["diff"].is_null());
        assert_eq!(changes[3]["diffTruncated"], true);
    }

    #[test]
    fn counts_header_like_lines_inside_a_hunk() {
        assert_eq!(count_changes("@@ -1,2 +1,2 @@\n--- old\n+++ new\n"), (1, 1));
        let snapshot = codex_turn_diff_snapshot(
            "t",
            "diff --git a/q.sql b/q.sql\n--- a/q.sql\n+++ b/q.sql\n@@ -1 +1 @@\n--- old\n+++ new\n",
            None,
        );
        assert_eq!(snapshot["files"][0]["additions"], 1);
        assert_eq!(snapshot["files"][0]["deletions"], 1);
    }

    #[test]
    fn projects_a_codex_turn_diff() {
        let diff = "diff --git a/a.js b/a.js\nindex 1..2 100644\n--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n x\n-y\n+z\ndiff --git a/new.js b/new.js\nnew file mode 100644\n--- /dev/null\n+++ b/new.js\n@@ -0,0 +1,1 @@\n+hello\n";
        let snapshot = codex_turn_diff_snapshot("turn-1", diff, Some("/w/repo"));
        assert_eq!(snapshot["changeSetId"], "turn-1:workspace");
        assert_eq!(snapshot["files"][0]["path"], "a.js");
        assert_eq!(snapshot["files"][0]["operation"], "modify");
        assert_eq!(snapshot["files"][1]["operation"], "create");
        assert_eq!(
            snapshot["totals"],
            json!({"files": 2, "additions": 2, "deletions": 1})
        );
        assert_eq!(
            snapshot["files"][0]["diff"],
            "@@ -1,2 +1,2 @@\n x\n-y\n+z\n"
        );
    }
}
