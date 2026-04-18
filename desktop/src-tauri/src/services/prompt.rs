use sqlx::SqlitePool;
use serde::Serialize;

const MAX_COMMENTS: usize = 8;
const MAX_COMMENT_BODY_CHARS: usize = 4_000;
const MAX_TOTAL_COMMENT_CHARS: usize = 12_000;

#[derive(Debug, Serialize)]
pub struct WakePayload {
    pub reason: Option<String>,
    pub issue: Option<IssueSummary>,
    pub comments: Vec<WakeComment>,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct IssueSummary {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub status: String,
    pub priority: String,
}

#[derive(Debug, Serialize)]
pub struct WakeComment {
    pub id: String,
    pub body: String,
    pub body_truncated: bool,
    pub created_at: String,
    pub author_type: String,
}

pub async fn build_wake_payload(
    pool: &SqlitePool,
    _company_id: &str,
    payload_json: Option<&str>,
) -> WakePayload {
    let mut result = WakePayload {
        reason: None,
        issue: None,
        comments: Vec::new(),
        truncated: false,
    };

    // Parse wakeup payload JSON if present
    let payload: serde_json::Value = match payload_json {
        Some(json) => serde_json::from_str(json).unwrap_or_default(),
        None => return result,
    };

    result.reason = payload.get("reason").and_then(|v| v.as_str()).map(String::from);

    // Load issue if issueId present
    if let Some(issue_id) = payload.get("issueId").and_then(|v| v.as_str()) {
        if let Ok(Some(issue)) = sqlx::query_as::<_, (String, String, String, String, String)>(
            "SELECT id, identifier, title, status, priority FROM issues WHERE id = ?"
        ).bind(issue_id).fetch_optional(pool).await {
            result.issue = Some(IssueSummary {
                id: issue.0, identifier: issue.1, title: issue.2, status: issue.3, priority: issue.4,
            });

            // Load recent comments for this issue
            if let Ok(comments) = sqlx::query_as::<_, (String, String, String, Option<String>, Option<String>)>(
                "SELECT id, body, created_at, author_agent_id, author_user_id FROM issue_comments WHERE issue_id = ? ORDER BY created_at DESC LIMIT ?"
            ).bind(issue_id).bind(MAX_COMMENTS as i64).fetch_all(pool).await {
                let mut total_chars = 0usize;
                for (id, body, created_at, agent_id, user_id) in comments.into_iter().rev() {
                    let (truncated_body, was_truncated) = if body.len() > MAX_COMMENT_BODY_CHARS {
                        (body[..MAX_COMMENT_BODY_CHARS].to_string(), true)
                    } else {
                        (body.clone(), false)
                    };

                    if total_chars + truncated_body.len() > MAX_TOTAL_COMMENT_CHARS {
                        result.truncated = true;
                        break;
                    }
                    total_chars += truncated_body.len();

                    let author_type = if agent_id.is_some() { "agent" } else if user_id.is_some() { "user" } else { "system" };
                    result.comments.push(WakeComment {
                        id, body: truncated_body, body_truncated: was_truncated,
                        created_at, author_type: author_type.to_string(),
                    });
                }
            }
        }
    }

    result
}

pub fn render_wake_prompt(payload: &WakePayload, agent_name: &str, resumed_session: bool) -> String {
    let mut prompt = String::new();

    if resumed_session {
        prompt.push_str("## Paperclip Resume Delta\n\n");
    } else {
        prompt.push_str("## Paperclip Wake Payload\n\n");
    }

    prompt.push_str(&format!("Agent: {}\n", agent_name));

    if let Some(reason) = &payload.reason {
        prompt.push_str(&format!("Wake reason: {}\n", reason));
    }

    if let Some(issue) = &payload.issue {
        prompt.push_str(&format!("\n### Issue: {} — {}\n", issue.identifier, issue.title));
        prompt.push_str(&format!("Status: {} | Priority: {}\n", issue.status, issue.priority));
    }

    if !payload.comments.is_empty() {
        prompt.push_str(&format!("\n### Recent Comments ({}):\n\n", payload.comments.len()));
        for comment in &payload.comments {
            prompt.push_str(&format!("**[{}]** ({})\n", comment.author_type, comment.created_at));
            prompt.push_str(&comment.body);
            if comment.body_truncated {
                prompt.push_str("\n[...truncated...]");
            }
            prompt.push_str("\n\n");
        }
        if payload.truncated {
            prompt.push_str("*Note: Some earlier comments were omitted due to length limits.*\n");
        }
    }

    prompt
}
