---
title: External Adapters
summary: Paperclip source를 수정하지 않고 adapter plugin 만들기
---

# External Adapters

Paperclip은 npm package 또는 local directory에서 설치되는 external adapter plugin을 지원합니다. external adapter는 built-in adapter와 똑같이 agent를 실행하고 output을 파싱하고 transcript를 렌더링하지만, 별도 package에 살기 때문에 Paperclip source 수정이 필요 없습니다.

## Built-in vs external

| | Built-in | External |
| --- | --- | --- |
| 위치 | `packages/adapters/` 내부 | 별도 npm package 또는 local directory |
| 등록 | registry에 hardcode | plugin system이 startup 때 load |
| UI parser | build-time static import | API로 dynamic load |
| 배포 | Paperclip release 포함 | 독립 versioning |

대부분의 third-party adapter나 내부 도구는 external adapter가 더 낫습니다.

## 최소 구조

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
```

## package.json 핵심 필드

```json
{
  "name": "my-paperclip-adapter",
  "type": "module",
  "paperclip": {
    "adapterUiParser": "1.0.0"
  },
  "exports": {
    ".": "./dist/index.js",
    "./server": "./dist/server/index.js",
    "./ui-parser": "./dist/ui-parser.js"
  },
  "files": ["dist"]
}
```

- `exports["."]`는 `createServerAdapter`를 export해야 합니다.
- `exports["./ui-parser"]`는 UI transcript parser module입니다.
- `paperclip.adapterUiParser`는 UI parser contract version입니다.

## Server module

plugin loader는 package root의 `createServerAdapter()`를 호출합니다.

```ts
export const type = "my_adapter";
export const label = "My Agent (local)";
export const models = [{ id: "model-a", label: "Model A" }];
export { createServerAdapter } from "./server/index.js";
```

`createServerAdapter()`는 `execute`, `testEnvironment`, `models`, `agentConfigurationDoc`을 포함한 server adapter module을 반환합니다.

## 배포와 설치

external adapter는 npm에 publish하거나 local path로 link할 수 있습니다. Paperclip startup 시 plugin system이 adapter를 load하고 UI/API에서 adapter type으로 사용할 수 있게 만듭니다.
