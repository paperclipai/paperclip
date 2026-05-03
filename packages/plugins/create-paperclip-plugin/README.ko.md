# @paperclipai/create-paperclip-plugin 한국어 README

새 Paperclip 플러그인을 만드는 scaffold 도구입니다.

```bash
npx @paperclipai/create-paperclip-plugin my-plugin
```

옵션을 포함한 예시:

```bash
npx @paperclipai/create-paperclip-plugin @acme/my-plugin \
  --template connector \
  --category connector \
  --display-name "Acme Connector" \
  --description "Syncs Acme data into Paperclip" \
  --author "Acme Inc"
```

지원 template:

- `default`
- `connector`
- `workspace`

지원 category:

- `connector`
- `workspace`
- `automation`
- `ui`

생성되는 것:

- type이 있는 manifest와 worker entrypoint
- `@paperclipai/plugin-sdk/ui` hook을 쓰는 예제 UI widget
- `@paperclipai/plugin-sdk/testing` 기반 테스트 파일
- SDK bundler preset을 사용하는 `esbuild`, `rollup` 설정
- hot reload용 dev server script (`paperclip-plugin-dev-server`)

현재 플러그인 런타임은 안정적인 shared component library를 제공하지 않습니다. 그래서 scaffold는 host UI kit이 아니라 일반 React element를 사용합니다.

이 레포 안에서 생성한 패키지는 `@paperclipai/plugin-sdk`를 `workspace:*`로 사용합니다.

레포 밖에서 생성할 때는 로컬 Paperclip checkout의 SDK를 `.paperclip-sdk/` tarball로 snapshot하고, 생성 패키지가 그 local file을 가리키도록 설정합니다.

명시적으로 SDK 위치를 지정할 수도 있습니다.

```bash
node packages/plugins/create-paperclip-plugin/dist/index.js @acme/my-plugin \
  --output /absolute/path/to/plugins \
  --sdk-path /absolute/path/to/paperclip/packages/plugins/sdk
```

## 생성 후 workflow

```bash
cd my-plugin
pnpm install
pnpm dev       # worker + manifest + ui bundle watch
pnpm dev:ui    # hot reload event가 있는 로컬 UI preview server
pnpm test
```
