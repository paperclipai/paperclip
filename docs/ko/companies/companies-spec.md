# Agent Companies Specification

Version: `agentcompanies/v1-draft`

Agent Company package는 회사, 팀, agent, project, task, skill을 YAML frontmatter가 있는 Markdown 파일로 표현하는 filesystem/GitHub-native format입니다.

이 spec은 Agent Skills specification을 대체하지 않고 확장합니다. `SKILL.md` 모델 위에 company/team/agent/project/task package 구조가 어떻게 조합되는지 정의합니다.

## 목적

- 사람이 읽고 쓸 수 있어야 합니다.
- local folder 또는 GitHub repository에서 바로 동작해야 합니다.
- central registry 없이도 사용할 수 있어야 합니다.
- upstream file attribution과 pinned reference를 보존해야 합니다.
- Agent Skills ecosystem을 재정의하지 않고 확장해야 합니다.
- Paperclip 밖에서도 쓸 수 있어야 합니다.

## 핵심 원칙

1. Markdown이 canonical입니다.
2. Git repository는 package container가 될 수 있습니다.
3. registry는 discovery layer일 뿐 authority가 아닙니다.
4. `SKILL.md`는 Agent Skills specification이 소유합니다.
5. 외부 reference는 immutable Git commit에 pin 가능해야 합니다.
6. attribution과 license metadata는 import/export 후에도 살아 있어야 합니다.
7. portable identity는 DB id가 아니라 slug와 relative path입니다.
8. convention-based folder structure가 verbose wiring 없이 동작해야 합니다.
9. vendor-specific fidelity는 optional extension에 둡니다.

## Package kinds

package root는 primary markdown file로 식별됩니다.

- `COMPANY.md`
- `TEAM.md`
- `AGENTS.md`
- `PROJECT.md`
- `TASK.md`
- `SKILL.md`

GitHub repo는 root에 하나의 package를 둘 수도 있고, subdirectory에 여러 package를 둘 수도 있습니다.

## Reserved paths

```text
COMPANY.md
TEAM.md
AGENTS.md
PROJECT.md
TASK.md
SKILL.md

agents/<slug>/AGENTS.md
teams/<slug>/TEAM.md
projects/<slug>/PROJECT.md
projects/<slug>/tasks/<slug>/TASK.md
tasks/<slug>/TASK.md
skills/<slug>/SKILL.md
.paperclip.yaml
```

`assets/`, `scripts/`, `references/` 같은 non-markdown directory는 허용됩니다. canonical content doc은 Markdown입니다.

## Common frontmatter

```yaml
schema: agentcompanies/v1
kind: company
slug: my-slug
name: Human Readable Name
description: Short description
version: 0.1.0
license: MIT
authors:
  - name: Jane Doe
metadata: {}
sources: []
```

`sources`는 provenance와 external reference를 위한 필드입니다. `metadata`는 tool-specific extension에 사용합니다.
