# Upstream provenance and deliberate adaptations

Reviewed 10 September 2026. Pin revisions when updating; do not auto-upgrade
workflow instructions or fetched executables during a delivery task.

| Project | Reviewed release | Immutable source |
| --- | --- | --- |
| GitHub Spec Kit | v1.0.5 | https://github.com/github/spec-kit/tree/a4e25ce6b96dc8e85f84206c6a54353fa9c5260b |
| AI-SDLC Framework | ai-sdlc-plugin-v0.20.1 | https://github.com/ai-sdlc-framework/ai-sdlc/tree/a5d0c67793d0d5965b1bedfee3da7ebfa9109cdd |

Spec Kit's MIT-licensed specification, plan, tasks and analysis method informs
the contract. This integration uses the existing project's documentation and
Paperclip tasks; it does not run `specify init`, create duplicate branches,
overwrite a constitution or install Spec Kit's workflow runner. The release
supports native skills for Codex, Claude Code, Cursor and Grok Build, but support
in an upstream integration is not proof of support in an installed harness.

AI-SDLC's Apache-2.0-licensed
[decision rubric](https://github.com/ai-sdlc-framework/ai-sdlc/blob/a5d0c67793d0d5965b1bedfee3da7ebfa9109cdd/ai-sdlc-plugin/skills/decision-rubric/SKILL.md)
informs the decision process. Adaptations: use the host question mechanism,
respect already granted authority, compare only genuine alternatives and store
decisions in Paperclip. The upstream rubric's separate catalogue command is not
activated. Neither its autonomous orchestrator, GitHub publishing pipeline,
default hooks nor DSSE attestation infrastructure is installed by this skill.

No claim of full AI-SDLC protocol conformance, signed attestation or formal
certification is made. Central policy, verified experiments and actual project
checks remain authoritative. A future executable integration needs its own
bounded requirement and tests; naming a framework does not prove its guarantees.
