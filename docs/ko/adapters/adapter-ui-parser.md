---
title: Adapter UI Parser Contract
summary: Adapter output을 Paperclip UI가 제대로 렌더링하게 만드는 parser 계약
---

# Adapter UI Parser Contract

Paperclip이 agent를 실행하면 stdout이 UI로 실시간 스트리밍됩니다. UI는 raw stdout line을 tool call, tool result, assistant message, system event 같은 transcript entry로 바꿀 parser가 필요합니다.

custom parser가 없으면 generic shell parser로 fallback합니다. 이 경우 tool command가 일반 assistant text처럼 보이고, duration이나 error 같은 구조가 사라집니다.

## 작동 구조

1. adapter package가 `src/ui-parser.ts`를 `dist/ui-parser.js`로 build합니다.
2. server startup 때 plugin loader가 해당 파일을 읽어 memory cache에 둡니다.
3. 사용자가 run을 열면 UI가 `GET /api/:type/ui-parser.js`로 parser를 가져옵니다.
4. browser에서 parser를 등록하고 이후 stdout line을 해당 parser로 처리합니다.

## package.json 계약

```json
{
  "paperclip": {
    "adapterUiParser": "1.0.0"
  },
  "exports": {
    ".": "./dist/server/index.js",
    "./ui-parser": "./dist/ui-parser.js"
  }
}
```

`paperclip.adapterUiParser`는 contract version입니다. host가 지원하지 않는 major version이면 warning을 남기고 generic parser를 사용합니다.

## Module export

`dist/ui-parser.js`는 다음 중 하나 이상을 export해야 합니다.

```ts
export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "assistant", ts, text: line }];
}
```

또는 stateful parser가 필요하면:

```ts
export function createStdoutParser() {
  return {
    parseLine(line: string, ts: string) {
      return [{ kind: "assistant", ts, text: line }];
    },
    reset() {}
  };
}
```

multi-line continuation, nested command, streaming status를 추적해야 하면 `createStdoutParser()` 방식이 더 적합합니다.

## 원칙

- UI parser는 browser에서 실행되므로 runtime import를 최소화합니다.
- parser 실패 시 generic parser로 fallback되어도 transcript가 완전히 깨지지 않게 설계합니다.
- tool call과 result에는 안정적인 `toolUseId`를 부여합니다.
- adapter stdout format이 바뀌면 parser contract도 같이 update합니다.
