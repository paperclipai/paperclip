/// Validate an issue status transition.
/// Returns Ok(new_status) if valid, Err with reason if invalid.
pub fn validate_transition(current_status: &str, requested_status: &str) -> Result<String, String> {
    let valid = match current_status {
        "backlog" => matches!(requested_status, "todo" | "cancelled"),
        "todo" => matches!(requested_status, "in_progress" | "backlog" | "cancelled"),
        "in_progress" => matches!(requested_status, "in_review" | "blocked" | "done" | "cancelled"),
        "in_review" => matches!(requested_status, "in_progress" | "done" | "cancelled"),
        "blocked" => matches!(requested_status, "in_progress" | "cancelled"),
        "done" => false, // Terminal state
        "cancelled" => false, // Terminal state
        _ => false,
    };

    if valid {
        Ok(requested_status.to_string())
    } else {
        Err(format!(
            "Invalid status transition: '{}' -> '{}'. {}",
            current_status,
            requested_status,
            match current_status {
                "done" | "cancelled" => "This issue is in a terminal state.",
                _ => "Check the valid transitions for this status.",
            }
        ))
    }
}
