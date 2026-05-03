---
title: 회사 가져오기와 내보내기
summary: 회사를 portable package로 export/import하기
---

# 회사 가져오기와 내보내기

Paperclip 회사는 portable markdown package로 내보내고, local directory나 GitHub에서 다시 가져올 수 있습니다. 회사 설정을 공유하거나, 템플릿을 복제하거나, agent team을 version-control할 때 유용합니다.

## 패키지 형식

export된 패키지는 Agent Companies specification을 따릅니다.

```text
my-company/
├── COMPANY.md
├── agents/
│   ├── ceo/AGENT.md
│   └── cto/AGENT.md
├── projects/
│   └── main/PROJECT.md
├── skills/
│   └── review/SKILL.md
├── tasks/
│   └── onboarding/TASK.md
└── .paperclip.yaml
```

- `COMPANY.md`: 회사 이름, 설명, metadata
- `AGENT.md`: 에이전트 정체성, 역할, instructions
- `SKILL.md`: Agent Skills 생태계와 호환되는 스킬
- `.paperclip.yaml`: adapter type, env input, budget 등 Paperclip 설정

## 내보내기

```sh
paperclipai company export <company-id> --out ./my-export
```

예시:

```sh
paperclipai company export abc123 --out ./backup --include company,agents,projects
paperclipai company export abc123 --out ./full-export --include company,agents,projects,tasks,skills
paperclipai company export abc123 --out ./skills-only --include skills --skills review,deploy
```

secret value, machine-local path, database ID는 내보내지 않습니다.

## 가져오기

```sh
paperclipai company import ./my-export
paperclipai company import https://github.com/org/repo
paperclipai company import https://github.com/org/repo/tree/main/companies/acme
paperclipai company import org/repo
paperclipai company import org/repo/companies/acme
```

## 대상 모드

- `new`: 패키지에서 새 회사를 만듭니다.
- `existing`: 기존 회사에 병합합니다. `--company-id`로 대상을 지정합니다.

## 충돌 처리

기존 회사로 가져올 때 이름 충돌이 날 수 있습니다.

- `rename`: 기본값. suffix를 붙여 충돌을 피합니다.
- `skip`: 이미 있는 엔티티는 건너뜁니다.
- `replace`: 기존 엔티티를 덮어씁니다. 안전 import에서는 허용되지 않습니다.

## 먼저 preview하기

항상 적용 전에 dry run으로 확인하세요.

```sh
paperclipai company import org/repo --target existing --company-id abc123 --dry-run
```

preview는 package contents, import plan, 필요한 env input, warning을 보여줍니다.

가져온 에이전트는 timer heartbeat가 꺼진 상태로 들어옵니다. assignment/on-demand wake 설정은 유지되지만, scheduled run은 운영자가 다시 켜기 전까지 비활성입니다.
