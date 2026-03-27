# @paperclipai/plugin-kitchen-sink-example

Kitchen Sink 是官方参考插件，在一个包中演示了几乎所有当前已实现的 Paperclip 插件功能。

它涵盖范围广泛：

- 完整插件页面
- 仪表盘小组件
- 项目和工单界面
- 评论界面
- 侧边栏界面
- 设置页面
- Worker 桥接数据/操作
- 事件、任务、Webhook、工具、流
- 状态、实体、资源、指标、活动
- 本地工作区和进程演示

本插件用于本地开发、贡献者入门和运行时回归测试。它不适合作为生产插件模板直接使用。

## 安装

```sh
pnpm --filter @paperclipai/plugin-kitchen-sink-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-kitchen-sink-example
```

或者在仓库构建完成后，通过 Paperclip 插件管理器将其作为内置示例安装。

## 说明

- 本地工作区和进程演示仅限受信任环境，默认使用安全的、经审查的命令。
- 插件设置页面允许你切换可选的演示界面和本地运行时行为。
- 部分 SDK 定义的宿主界面仍依赖于 Paperclip 宿主的可见化集成；本包旨在测试当前已挂载的界面，并使其余部分的状态一目了然。
