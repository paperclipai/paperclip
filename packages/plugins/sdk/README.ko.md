# @paperclipai/plugin-sdk 한국어 README

Paperclip 플러그인 작성자를 위한 공식 TypeScript SDK입니다.

- **Worker SDK**: `@paperclipai/plugin-sdk`
- **UI SDK**: `@paperclipai/plugin-sdk/ui`
- **Testing**: `@paperclipai/plugin-sdk/testing`
- **Bundlers**: `@paperclipai/plugin-sdk/bundlers`
- **Dev server**: `@paperclipai/plugin-sdk/dev-server`

원문 전체 API reference는 [`README.md`](./README.md)를 기준으로 보세요. 이 문서는 한국어 개요와 개발 흐름을 빠르게 이해하기 위한 번역본입니다.

## package surface

| import | 용도 |
| --- | --- |
| `@paperclipai/plugin-sdk` | worker entry: `definePlugin`, `runWorker`, context type |
| `@paperclipai/plugin-sdk/ui` | UI entry: `usePluginData`, `usePluginAction`, `usePluginStream`, `useHostContext` |
| `@paperclipai/plugin-sdk/testing` | unit/integration test용 in-memory host harness |
| `@paperclipai/plugin-sdk/bundlers` | worker/manifest/ui build preset |
| `@paperclipai/plugin-sdk/dev-server` | plugin UI static server와 SSE reload |
| `@paperclipai/plugin-sdk/protocol` | JSON-RPC protocol type과 helper |

## manifest entrypoint

플러그인 manifest에는 entrypoint를 선언합니다.

- `entrypoints.worker`: 필수. worker bundle 경로입니다. host가 이 파일을 로드하고 `setup(ctx)`를 호출합니다.
- `entrypoints.ui`: UI를 쓰는 경우 필요합니다. slot/launcher용 UI bundle directory입니다.

## 설치

```bash
pnpm add @paperclipai/plugin-sdk
```

## 현재 주의사항

SDK는 로컬 개발과 first-party example에는 충분히 안정적이지만, runtime deployment model은 아직 초기 단계입니다.

- plugin worker와 plugin UI는 현재 trusted code로 취급해야 합니다.
- plugin UI bundle은 Paperclip app 안에서 same-origin JavaScript로 실행됩니다.
- manifest capability는 frontend sandbox가 아닙니다.
- local path install과 repo example plugin은 개발 workflow입니다.
- 배포용 plugin은 npm package로 publish한 뒤 runtime에서 설치하는 경로를 기준으로 보세요.
- 현재 host runtime은 writable filesystem, runtime npm, package registry network access를 기대합니다.
- multi-instance cloud deployment는 shared artifact/distribution model이 더 필요합니다.
- host는 아직 안정적인 shared React component kit을 제공하지 않습니다.

## worker quick start

```ts
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.events.on("issue.created", async (event) => {
      ctx.logger.info("Issue created", { issueId: event.entityId });
    });

    ctx.data.register("health", async () => ({ status: "ok" }));
    ctx.actions.register("ping", async () => ({ pong: true }));
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
```

`runWorker(plugin, import.meta.url)`는 host가 worker를 `node dist/worker.js`로 실행할 때 RPC host를 시작하고 프로세스를 유지하기 위해 필요합니다.

## lifecycle

| hook | 용도 |
| --- | --- |
| `setup(ctx)` | 필수. startup 시 한 번 호출됩니다. event handler, job, data/action/tool 등을 등록합니다. |
| `onHealth?()` | health dashboard용 상태 반환 |
| `onConfigChanged?(newConfig)` | restart 없이 새 config 적용 |
| `onShutdown?()` | process exit 전 cleanup |
| `onValidateConfig?(config)` | settings UI / Test Connection 검증 |
| `onWebhook?(input)` | plugin webhook 처리 |

## context

`setup(ctx)`에서 다음 capability-gated API를 사용할 수 있습니다.

`config`, `events`, `jobs`, `launchers`, `http`, `secrets`, `activity`, `state`, `entities`, `projects`, `companies`, `issues`, `agents`, `goals`, `data`, `actions`, `streams`, `tools`, `metrics`, `logger`, `manifest`.

## events

`ctx.events.on(name, handler)`로 domain event를 구독합니다.

대표 이벤트:

- `company.created`, `company.updated`
- `project.created`, `project.updated`
- `issue.created`, `issue.updated`, `issue.comment.created`
- `agent.created`, `agent.updated`, `agent.run.started`, `agent.run.finished`
- `approval.created`, `approval.decided`
- `budget.incident.opened`, `budget.incident.resolved`
- `activity.logged`

plugin-scoped event는 `ctx.events.emit(name, companyId, payload)`로 발행합니다.

## scheduled jobs

반복 sync, digest report, cleanup 같은 작업은 scheduled job으로 선언합니다.

1. manifest capabilities에 `jobs.schedule`을 추가합니다.
2. `manifest.jobs`에 `jobKey`, `displayName`, `schedule`을 선언합니다.
3. `ctx.jobs.register(jobKey, handler)`로 handler를 등록합니다.

cron은 5-field 형식입니다.

```text
minute hour day-of-month month day-of-week
```

예:

- `0 * * * *`: 매시 정각
- `*/5 * * * *`: 5분마다
- `0 2 * * *`: 매일 02:00
