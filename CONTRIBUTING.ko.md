# 기여 가이드

Paperclip에 기여하려면 변경 범위와 리뷰 가능성을 먼저 생각해야 합니다. 작은 수정도, 깊이 있는 큰 변경도 환영하지만, core product feature는 roadmap과 유지보수 책임이 걸려 있으므로 먼저 조율하는 것이 좋습니다.

## PR이 받아들여지는 두 경로

### 1. 작고 명확한 변경

가장 빨리 merge되는 방식입니다.

- 고칠 것 하나만 잡습니다.
- 가능한 적은 파일을 수정합니다.
- 리뷰어가 변경 의도를 바로 이해할 수 있어야 합니다.
- tests와 CI가 통과해야 합니다.
- Greptile score 5/5와 모든 comment 대응이 필요합니다.
- [PR template](.github/PULL_REQUEST_TEMPLATE.md)을 사용합니다.

### 2. 크거나 영향이 큰 변경

먼저 Discord `#dev`에서 논의합니다.

- 풀려는 문제를 설명합니다.
- rough approach를 공유합니다.
- 대략 동의가 잡힌 뒤 구현합니다.
- PR에는 before/after screenshot 또는 짧은 영상, 변경 내용과 이유, 검증 기록, risk를 포함합니다.

## 모든 PR 요구사항

### PR template

모든 PR은 [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md)를 따라야 합니다. GitHub API 등으로 template이 자동 삽입되지 않았다면 직접 복사해 PR description에 넣습니다.

### Model Used

모든 PR에는 어떤 AI model이 변경에 사용되었는지 적어야 합니다. provider, 정확한 model ID/version, context window, reasoning/tool 사용 정보를 포함합니다. AI를 쓰지 않았다면 `None — human-authored`라고 적습니다.

### Tests

로컬에서 test를 먼저 실행하고, push 후 CI green을 확인합니다.

### Greptile review

Greptile comment가 있으면 모두 수정하거나 답변하고 re-review를 요청합니다.

## Feature contribution

core product feature는 먼저 [ROADMAP.md](ROADMAP.md)를 확인하고 Discord `#dev`에서 논의합니다. extension으로 맞는 아이디어는 [plugin system](doc/plugins/PLUGIN_SPEC.md)으로 만드는 것을 우선 고려합니다.

bug fix, docs 개선, 작고 명확한 polish는 여전히 가장 쉽게 merge되는 기여입니다.

## 좋은 PR 메시지

PR description은 “project 전체 맥락 → 문제 → 왜 필요한가 → 무엇을 바꿨는가 → 어떻게 검증했는가” 흐름으로 씁니다. UI/동작 변경이면 screenshot 또는 짧은 영상을 포함하는 것이 좋습니다.
