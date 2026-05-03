---
name: paperclip-create-plugin
description: >
  Paperclip plugin을 scaffold하거나 문서화할 때 쓰는 skill입니다.
  alpha SDK/runtime의 worker/UI surface, route convention, verification 절차를 다룹니다.
---

# Create a Paperclip Plugin

Paperclip plugin을 만들거나 example plugin을 추가하거나 plugin authoring docs를 업데이트할 때 사용합니다.

## Ground rules

필요하면 먼저 읽습니다.

1. `doc/plugins/PLUGIN_AUTHORING_GUIDE.md`
2. `packages/plugins/sdk/README.md`
3. `doc/plugins/PLUGIN_SPEC.md`

현재 runtime 가정:

- plugin worker는 trusted code입니다.
- plugin UI는 trusted same-origin host code입니다.
- worker API는 capability-gated입니다.
- plugin UI는 manifest capability로 sandbox되지 않습니다.
- host-provided shared UI component kit는 아직 없습니다.
- `ctx.assets`는 현재 runtime에서 지원되지 않습니다.

## 권장 workflow

boilerplate를 직접 쓰지 말고 scaffold package를 사용합니다.

```sh
pnpm --filter @paperclipai/create-paperclip-plugin build
node packages/plugins/create-paperclip-plugin/dist/index.js <npm-package-name> --output <target-dir>
```

repo 내부 example은 `packages/plugins/examples/` 아래에 두는 것이 보통입니다.

## scaffold 후 확인

- `src/manifest.ts`
- `src/worker.ts`
- `src/ui/index.tsx`
- `tests/plugin.spec.ts`
- `package.json`

검증:

```sh
pnpm --filter <plugin-package> typecheck
pnpm --filter <plugin-package> test
pnpm --filter <plugin-package> build
```
