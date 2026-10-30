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
    pub qualification_pending: bool,
}

pub(crate) fn acpx_release_profile(agent: &str) -> Option<AcpxReleaseProfile> {
    Some(match agent {
        "antigravity" => AcpxReleaseProfile {
            agent_server_package: "native:antigravity-acp",
            agent_server_version: "1.4.3",
            agent_runtime_package: Some("native:antigravity-localharness"),
            agent_runtime_version: Some("1.4.3"),
            command_digest:
                "sha256:acf5f574b6b9ec4388ff9d081890caa330e66bf1ae3fe3b08e7f0fb0e851b9ce",
            requires_provider_policy: true,
            qualification_pending: true,
        },
        "grok" => AcpxReleaseProfile {
            agent_server_package: "builtin:grok-acp",
            agent_server_version: "1",
            agent_runtime_package: Some("native:grok"),
            agent_runtime_version: Some("1.0.13"),
            command_digest:
                "sha256:f0b698395a3704ed2ffaf84ea19bdb20c36c8a0a70b7c629c7b6ffe144e59e55",
            requires_provider_policy: false,
            qualification_pending: false,
        },
        "pi" => AcpxReleaseProfile {
            agent_server_package: "pi-acp",
            agent_server_version: "0.0.33",
            agent_runtime_package: Some("@earendil-works/pi-coding-agent"),
            agent_runtime_version: Some("1.0.0"),
            command_digest:
                "sha256:4a555c1d8622addaeb1a02c1bddc5554ce81a316f98e7120029aad990e44d9dd",
            requires_provider_policy: true,
            qualification_pending: false,
        },
        "cursor" => AcpxReleaseProfile {
            agent_server_package: "cursor-agent",
            agent_server_version: "2026.09.26-dd393fe",
            agent_runtime_package: None,
            agent_runtime_version: None,
            command_digest:
                "sha256:759e7415fea8ed2b6b0e6f362b57652b8768835f9d1fdae4a94c1b5eb3669301",
            requires_provider_policy: true,
            qualification_pending: false,
        },
        "copilot" => AcpxReleaseProfile {
            agent_server_package: "@github/copilot",
            agent_server_version: "1.0.88",
            agent_runtime_package: None,
            agent_runtime_version: None,
            command_digest:
                "sha256:ef496fc5e7c56680c1c992bbbb266050fc8644611fad7de0a9745f2adea47afe",
            requires_provider_policy: true,
            qualification_pending: false,
        },
        "claude" => AcpxReleaseProfile {
            agent_server_package: "@agentclientprotocol/claude-agent-acp",
            agent_server_version: "0.73.0",
            agent_runtime_package: Some("@anthropic-ai/claude-agent-sdk"),
            agent_runtime_version: Some("0.3.286"),
            command_digest:
                "sha256:9d73d1f0f121fb96cc8badb28c22d5bff02d8582eb2e40360a81c189e1b9422a",
            requires_provider_policy: false,
            qualification_pending: false,
        },
        "codex" => AcpxReleaseProfile {
            agent_server_package: "@agentclientprotocol/codex-acp",
            agent_server_version: "1.6.2",
            agent_runtime_package: Some("@openai/codex"),
            agent_runtime_version: Some("0.160.0"),
            command_digest:
                "sha256:443491f4e814501a5dc47347e4510e84faeec9c9382e2d4e53bfe69386d5aabc",
            requires_provider_policy: false,
            qualification_pending: false,
        },
        _ => return None,
    })
}
