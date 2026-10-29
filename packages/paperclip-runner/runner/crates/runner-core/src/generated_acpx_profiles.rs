// Generated from acpx-profiles.json and cursor-distributions.json. Do not edit.
pub(crate) const QUALIFIED_ACPX_VERSION: &str = "0.13.1";
pub(crate) const ACPX_DRIVER_KIND: &str = "acpx_runtime";

#[derive(Debug)]
pub(crate) struct AcpxReleaseProfile {
    pub agent_server_package: &'static str,
    pub agent_server_version: &'static str,
    pub agent_runtime_package: Option<&'static str>,
    pub agent_runtime_version: Option<&'static str>,
    pub command_digest: &'static str,
    pub requires_provider_policy: bool,
}

pub(crate) fn acpx_release_profile(agent: &str) -> Option<AcpxReleaseProfile> {
    Some(match agent {
        "grok" => AcpxReleaseProfile {
            agent_server_package: "builtin:grok-acp",
            agent_server_version: "1",
            agent_runtime_package: Some("native:grok"),
            agent_runtime_version: Some("1.0.13"),
            command_digest:
                "sha256:f43a6f5a583972cdcb422784969cd6a97654655b0f135f1cf178317909c404f8",
            requires_provider_policy: false,
        },
        "pi" => AcpxReleaseProfile {
            agent_server_package: "pi-acp",
            agent_server_version: "0.0.33",
            agent_runtime_package: Some("@earendil-works/pi-coding-agent"),
            agent_runtime_version: Some("1.0.0"),
            command_digest:
                "sha256:0260d5810e9247986800ad46c1f9b3511a5abd06cb8f142405d5caacbc3960fc",
            requires_provider_policy: true,
        },
        "cursor" => AcpxReleaseProfile {
            agent_server_package: "cursor-agent",
            agent_server_version: "2026.09.26-dd393fe",
            agent_runtime_package: None,
            agent_runtime_version: None,
            command_digest:
                "sha256:759e7415fea8ed2b6b0e6f362b57652b8768835f9d1fdae4a94c1b5eb3669301",
            requires_provider_policy: true,
        },
        "copilot" => AcpxReleaseProfile {
            agent_server_package: "@github/copilot",
            agent_server_version: "1.0.88",
            agent_runtime_package: None,
            agent_runtime_version: None,
            command_digest:
                "sha256:7b8a6a31925256d225ea3d72fdcfd81b70a45c4b67d3eb0ee5073efff9ac8f8b",
            requires_provider_policy: true,
        },
        "claude" => AcpxReleaseProfile {
            agent_server_package: "@agentclientprotocol/claude-agent-acp",
            agent_server_version: "0.73.0",
            agent_runtime_package: Some("@anthropic-ai/claude-agent-sdk"),
            agent_runtime_version: Some("0.3.286"),
            command_digest:
                "sha256:9d73d1f0f121fb96cc8badb28c22d5bff02d8582eb2e40360a81c189e1b9422a",
            requires_provider_policy: false,
        },
        "codex" => AcpxReleaseProfile {
            agent_server_package: "@agentclientprotocol/codex-acp",
            agent_server_version: "1.6.2",
            agent_runtime_package: Some("@openai/codex"),
            agent_runtime_version: Some("0.160.0"),
            command_digest:
                "sha256:443491f4e814501a5dc47347e4510e84faeec9c9382e2d4e53bfe69386d5aabc",
            requires_provider_policy: false,
        },
        _ => return None,
    })
}
