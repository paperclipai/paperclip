# @paperclipai/ui

Paperclip board UI의 production static asset package입니다.

## 배포되는 것

npm package에는 `dist/` 아래 production build가 포함됩니다. UI source tree나 workspace 전용 dependency는 포함하지 않습니다.

## Storybook

Storybook 설정, stories, fixtures는 `ui/storybook/` 아래에 있습니다.

```sh
pnpm --filter @paperclipai/ui storybook
pnpm --filter @paperclipai/ui build-storybook
```

## 일반 사용

package를 설치한 뒤 `node_modules/@paperclipai/ui/dist`의 built file을 serve하거나 복사해 사용합니다.
