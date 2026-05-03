# Roadmap

이 문서는 `README.md`의 roadmap preview를 확장한 것입니다. Paperclip은 빠르게 움직이는 프로젝트이므로 아래 목록은 약속된 일정이 아니라 방향성입니다.

core feature에 기여하려면 먼저 Discord `#dev`에서 조율하세요. bug, docs, polish, 작고 명확한 개선은 여전히 가장 쉽게 merge되는 영역입니다. 오늘 Paperclip을 확장하려면 [plugin system](doc/plugins/PLUGIN_SPEC.md)을 우선 고려하세요.

## Milestones

### 완료됨

- **Plugin system** — core는 얇게 유지하고, knowledge base, tracing, queue, editor 같은 선택 기능은 plugin으로 확장합니다.
- **OpenClaw / claw-style agent employees** — narrow built-in runtime을 넘어 다양한 agent ecosystem을 채용하고 관리합니다.
- **companies.sh import/export** — org structure, agent definition, reusable company setup을 환경 간 이동할 수 있게 합니다.
- **Easy AGENTS.md configurations** — repo-native한 설정으로 agent team setup 장벽을 낮춥니다.
- **Skills Manager** — agent가 skill을 발견, 설치, 사용할 수 있는 실용적인 layer를 제공합니다.
- **Scheduled Routines** — report, review, periodic work를 first-class schedule로 다룹니다.
- **Better Budgeting** — spend visibility, hard stop, operator control을 강화합니다.
- **Agent Reviews and Approvals** — reviewer routing, approval gate, change request, audit trail을 task model 안에 넣습니다.
- **Multiple Human Users** — solo operator에서 team supervision으로 확장합니다.

### 예정/방향

- **Cloud / Sandbox agents** — remote/sandboxed environment에서 agent를 실행하면서 같은 control-plane model을 유지합니다.
- **Artifacts & Work Products** — agent output, preview, deployable result를 더 명확히 보여줍니다.
- **Memory / Knowledge** — company, agent, project의 durable memory와 recall surface를 강화합니다.
- **Enforced Outcomes** — 완료 기준을 vague status update가 아니라 merged code, published artifact, shipped docs, explicit decision으로 더 엄격하게 만듭니다.
- **MAXIMIZER MODE** — 더 공격적인 delegation과 follow-through를 budget, visibility, governance 안에서 실행합니다.
- **Deep Planning** — revisionable plan과 strategy-heavy work review loop를 강화합니다.
- **Work Queues** — support, triage, review, backlog intake 같은 반복 입력을 queue-style stream으로 처리합니다.
- **Self-Organization** — agent가 role, delegation, routine 같은 구조 변경을 제안할 수 있게 합니다.
- **Automatic Organizational Learning** — 완료된 작업을 playbook, recurring fix, decision pattern으로 저장합니다.
- **CEO Chat** — leadership agent와 가볍게 대화하되, 결과는 plan, issue, approval, decision으로 귀결되게 합니다.
- **Cloud deployments** — local-first를 유지하면서 shared deployment story를 강화합니다.
- **Desktop App** — day-to-day operator가 더 쉽게 접근하고 지속적으로 띄워둘 수 있는 desktop experience를 제공합니다.
