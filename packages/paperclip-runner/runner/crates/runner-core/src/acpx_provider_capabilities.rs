//! Runner-owned provider admission metadata. These capabilities are selected
//! only after the descriptor's pinned profile and launch authority validate;
//! they cannot be enabled by a sidecar event or a caller-supplied flag.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RunAttachmentPolicy {
    ImmutableInstructions,
    AuthenticatedRunGrants,
    AuthenticatedAssetPaths,
}

pub(crate) fn run_attachment_policy(agent: &str) -> RunAttachmentPolicy {
    match agent {
        "cursor" | "copilot" | "pi" => RunAttachmentPolicy::AuthenticatedRunGrants,
        "claude" => RunAttachmentPolicy::AuthenticatedAssetPaths,
        _ => RunAttachmentPolicy::ImmutableInstructions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_qualified_providers_opt_into_run_grant_rotation() {
        assert_eq!(
            run_attachment_policy("cursor"),
            RunAttachmentPolicy::AuthenticatedRunGrants
        );
        assert_eq!(
            run_attachment_policy("copilot"),
            RunAttachmentPolicy::AuthenticatedRunGrants
        );
        assert_eq!(
            run_attachment_policy("pi"),
            RunAttachmentPolicy::AuthenticatedRunGrants
        );
        assert_eq!(
            run_attachment_policy("claude"),
            RunAttachmentPolicy::AuthenticatedAssetPaths
        );
        for agent in ["codex", "grok", "unknown"] {
            assert_eq!(
                run_attachment_policy(agent),
                RunAttachmentPolicy::ImmutableInstructions
            );
        }
    }
}
