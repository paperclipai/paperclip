---
title: Writing a Skill
summary: SKILL.md 형식과 작성 원칙
---

# Writing a Skill

Skill은 에이전트가 heartbeat 중 필요할 때 불러 쓰는 재사용 가능한 지시문입니다. 특정 작업을 어떻게 수행해야 하는지 알려주는 Markdown 파일입니다.

## 구조

```text
skills/
└── my-skill/
    ├── SKILL.md
    └── references/
        └── examples.md
```

## SKILL.md 형식

```markdown
---
name: my-skill
description: >
  Short description of what this skill does and when to use it.
  This acts as routing logic.
---

# My Skill

Detailed instructions for the agent...
```

## Frontmatter 필드

- `name` — kebab-case 고유 식별자
- `description` — 에이전트가 이 skill을 언제 로드해야 하는지 판단하는 routing 설명

description은 마케팅 문구가 아니라 의사결정 규칙이어야 합니다. “use when”, “do not use when”을 분명히 적는 것이 좋습니다.

## Runtime 동작

1. 에이전트가 skill metadata를 봅니다.
2. 현재 task와 관련 있는지 판단합니다.
3. 관련 있으면 `SKILL.md` 전체를 로드합니다.
4. skill 지시에 따라 작업합니다.

이 방식은 기본 prompt를 작게 유지하면서 필요한 세부 지시만 on-demand로 불러오게 합니다.

## 작성 원칙

- routing description을 구체적으로 씁니다.
- 실행 가능한 절차와 API 예시를 포함합니다.
- 하나의 skill은 하나의 concern만 다룹니다.
- 긴 참고 자료는 `references/`에 둡니다.
- agent가 애매하게 해석할 수 있는 표현을 줄입니다.

Adapter는 skill을 각 agent runtime에 주입할 책임이 있습니다. Claude local adapter는 temp directory와 `--add-dir`를 사용하고, Codex local adapter는 global skills directory를 사용할 수 있습니다.
