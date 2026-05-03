---
title: Creating an Adapter
summary: Custom adapter 만드는 방법
---

# Creating an Adapter

Custom adapter는 Paperclip을 임의의 agent runtime과 연결합니다.

## 두 가지 경로

| | Built-in | External plugin |
| --- | --- | --- |
| Source | Paperclip repo 내부 | 별도 npm package |
| Distribution | Paperclip에 포함 | 독립 배포 |
| UI parser | static import | API를 통한 dynamic load |
| Registration | registry 수정 필요 | startup 때 자동 로드 |
| 적합한 경우 | core adapter, upstream contributor | third-party adapter, 내부 도구 |

대부분의 경우 external adapter plugin이 낫습니다. Paperclip source를 덜 건드리고 독립적으로 versioning할 수 있습니다.

## Package structure

```text
my-adapter/
  package.json
  tsconfig.json
  src/
    index.ts
    server/
      index.ts
      execute.ts
      parse.ts
      test.ts
    ui-parser.ts
    cli/
      index.ts
      format-event.ts
```

## Metadata

`src/index.ts`는 server, UI, CLI에서 모두 소비하는 공통 metadata입니다. 가능하면 dependency-free로 유지합니다.

```ts
export const type = "my_agent";
export const label = "My Agent (local)";
export const models = [{ id: "model-a", label: "Model A" }];

export const agentConfigurationDoc = `# my_agent configuration
Use when: ...
Don't use when: ...
Core fields: ...
`;

export { createServerAdapter } from "./server/index.js";
```

## Server execute

`src/server/execute.ts`가 핵심입니다. `AdapterExecutionContext`를 받고 `AdapterExecutionResult`를 반환합니다.

주요 책임:

1. `asString`, `asNumber` 같은 safe helper로 config를 읽습니다.
2. `buildPaperclipEnv(agent)`로 `PAPERCLIP_*` 환경 변수를 만듭니다.
3. session state를 `runtime.sessionParams`에서 복원합니다.
4. template과 context로 prompt를 렌더링합니다.
5. `runChildProcess()` 또는 `fetch()`로 runtime을 호출합니다.
6. usage, cost, session state, error를 파싱합니다.
7. session이 깨졌으면 fresh run으로 재시도하고 `clearSession: true`를 반환합니다.

## 테스트

adapter는 environment diagnostic을 제공해야 합니다. CLI, API, UI에서 adapter가 실행 가능한지 확인할 수 있어야 운영자가 원인을 빠르게 찾습니다.
