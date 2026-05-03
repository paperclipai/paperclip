# ClipHub Plan

ClipHub는 Paperclip team configuration marketplace 구상입니다. 이 계획은 markdown-first company package 방향보다 이전 문서이므로, 현재 package format과 import/export rollout은 `docs/ko/companies/companies-spec.md`를 우선 참고합니다.

## Vision

ClipHub는 whole-company AI team configuration을 판매/배포하는 marketplace입니다.

판매 단위:

- org chart
- agent role
- inter-agent workflow
- governance rule
- project template
- skill bundle

핵심 value prop은 “org design을 건너뛰고 몇 분 안에 shipping team을 설치한다”입니다.

## Product taxonomy

### Team blueprints

완전한 Paperclip company configuration입니다.

- org chart
- agent configs
- governance rules
- project templates
- skills & instructions

### Agent blueprints

single-agent configuration입니다. role definition, prompt/template, adapter config, reporting expectation, skill bundle, governance default를 포함합니다.

### Skills

portable `SKILL.md`와 관련 tool/script입니다.

### Governance templates

budget threshold, approval chain, escalation, billing code structure를 묶은 template입니다.

## 현재 해석

ClipHub라는 product surface는 아직 방향성 문서입니다. 실제 구현/이식 가능한 format은 Agent Companies specification과 import/export system을 중심으로 보는 것이 맞습니다.
