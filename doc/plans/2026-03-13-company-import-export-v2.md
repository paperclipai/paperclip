# 2026-03-13 公司导入/导出 V2 计划

状态：拟议实施方案
日期：2026-03-13
受众：产品与工程团队
在包格式方向上取代以下文档：
- `doc/plans/2026-02-16-module-system.md` 中将公司模板描述为仅 JSON 的相关章节
- `docs/specs/cliphub-plan.md` 中与 markdown 优先包模型冲突的蓝图包结构假设

## 1. 目的

本文档定义 Paperclip 公司导入/导出的下一阶段计划。

核心转变包括：

- 从 Paperclip 专有的 JSON 优先可移植包转向 markdown 优先包格式
- 将 GitHub 仓库作为一级包来源
- 将公司包模型视为现有 Agent Skills 生态的扩展，而非另起炉灶创建独立的 skill 格式
- 支持公司、团队、agent 及 skill 的复用，无需中央注册中心

规范性包格式草案位于：

- `docs/companies/companies-spec.md`

本计划涉及 Paperclip 内部的实施与推广工作。

适配器层面的 skill 推广详情请参见：

- `doc/plans/2026-03-14-adapter-skill-sync-rollout.md`

## 2. 执行摘要

Paperclip 代码库中已具备可移植性基础原语：

- 服务端导入/导出/预览 API
- CLI 导入/导出命令
- 共享可移植性类型与验证器

这些基础原语将被切换到新包模型，而非为向后兼容性进行扩展。

新方向如下：

1. markdown 优先的包编写方式
2. GitHub 仓库或本地文件夹作为默认的真实来源
3. 面向 agent-company 运行时（而非仅限 Paperclip）的厂商中立基础包规范
4. 公司包模型明确作为 Agent Skills 的扩展
5. 未来不再依赖 `paperclip.manifest.json`
6. 针对常见场景按约定进行隐式文件夹发现
7. 始终生成 `.paperclip.yaml` 附加文件，用于存放高保真的 Paperclip 专有详情
8. 导入时进行包图谱解析
9. 支持依赖感知树形选择的实体级导入界面
10. `skills.sh` 兼容性是 V1 阶段对 skill 包及 skill 安装流程的硬性要求
11. 适配器感知的 skill 同步界面，使 Paperclip 能在适配器支持时读取、对比、启用、禁用并协调 skill

## 3. 产品目标

### 3.1 目标

- 用户可以将 Paperclip 指向本地文件夹或 GitHub 仓库，无需任何注册中心即可导入公司包。
- 包可由人工通过普通 git 工作流进行读写。
- 包可包含以下内容：
  - 公司定义
  - 组织子树/团队定义
  - agent 定义
  - 可选的初始项目和任务
  - 可复用的 skill
- V1 阶段的 skill 支持与现有 `skills.sh` / Agent Skills 生态兼容。
- 用户可以将内容导入：
  - 新建公司
  - 已有公司
- 导入预览展示：
  - 将会创建的内容
  - 将会更新的内容
  - 将被跳过的内容
  - 外部引用的内容
  - 需要密钥或审批的内容
- 导出保留归因、许可证信息及固定的上游引用。
- 导出产出一个干净的厂商中立包，以及一个 Paperclip 附加文件。
- `companies.sh` 未来可作为实现此格式的仓库的发现/索引层。

### 3.2 非目标

- 包的有效性不需要中央注册中心。
- 这不是完整的数据库备份/恢复方案。
- 不尝试导出以下运行时状态：
  - heartbeat 运行记录
  - API 密钥
  - 消耗总计
  - 运行会话
  - 临时工作空间
- 在团队可移植性发布之前，不需要优先建立运行时 `teams` 表。

## 4. 代码库现状

当前实现位于以下位置：

- 共享类型：`packages/shared/src/types/company-portability.ts`
- 共享验证器：`packages/shared/src/validators/company-portability.ts`
- 服务端路由：`server/src/routes/companies.ts`
- 服务端服务：`server/src/services/company-portability.ts`
- CLI 命令：`cli/src/commands/client/company.ts`

当前产品局限性：

1. 导入/导出界面仍需深化树形选择及 skill/包管理的精细度。
2. 适配器专属 skill 同步在各适配器之间仍不一致，在不支持时必须能优雅降级。
3. 项目和初始任务在导出时应保持为可选项，而非默认包内容。
4. 导入/导出在归因、固定验证和可执行包警告方面仍需更强的覆盖。
5. 当前的 markdown frontmatter 解析器有意保持轻量级，应限制在已记录的结构内。

## 5. 规范包方向

### 5.1 规范编写格式

规范编写格式采用以下文件之一为根的 markdown 优先包：

- `COMPANY.md`
- `TEAM.md`
- `AGENTS.md`
- `PROJECT.md`
- `TASK.md`
- `SKILL.md`

规范性草案位于：

- `docs/companies/companies-spec.md`

### 5.2 与 Agent Skills 的关系

Paperclip 不得重新定义 `SKILL.md`。

规则：

- `SKILL.md` 保持与 Agent Skills 兼容
- 公司包模型是 Agent Skills 的扩展
- 基础包为厂商中立，面向任何 agent-company 运行时
- Paperclip 专有的高保真内容位于 `.paperclip.yaml`
- Paperclip 可以解析并安装 `SKILL.md` 包，但不得要求 Paperclip 专有的 skill 格式
- `skills.sh` 兼容性是 V1 阶段的硬性要求，而非未来可选项

### 5.3 Agent 与 Skill 的关联

`AGENTS.md` 应通过 skill 短名称或 slug 关联 skill，而非在常见场景中使用冗长路径。

首选示例：

- `skills: [review, react-best-practices]`

解析模型：

- `review` 按包约定解析为 `skills/review/SKILL.md`
- 如果 skill 是外部引用的，由 skill 包自行处理该复杂性
- 导出器应在 `AGENTS.md` 中优先使用基于短名称的关联
- 导入器应优先将短名称解析为本地包中的 skill，然后再解析为已引用或已安装的公司 skill
### 5.4 基础包与 Paperclip 扩展

仓库格式应分为两层：

- 基础包：
  - 最小化、可读、社交友好、厂商中立
  - 按约定进行隐式文件夹发现
  - 默认不含 Paperclip 专有的运行时字段
- Paperclip 扩展：
  - `.paperclip.yaml`
  - 适配器/运行时/权限/预算/工作空间高保真信息
  - 由 Paperclip 工具以附加文件形式生成，同时保持基础包可读

### 5.5 与当前 V1 清单的关系

`paperclip.manifest.json` 不属于未来包方向的一部分。

这应被视为产品方向上的硬性切换。

- markdown 优先的仓库结构是目标
- 不应再对旧清单模型进行新的投入
- 未来的可移植性 API 和界面应仅面向 markdown 优先模型

## 6. Package Graph Model

### 6.1 Entity Kinds

Paperclip import/export should support these entity kinds:

- company
- team
- agent
- project
- task
- skill

### 6.2 Team Semantics

`team` is a package concept first, not a database-table requirement.

In Paperclip V2 portability:

- a team is an importable org subtree
- it is rooted at a manager agent
- it can be attached under a target manager in an existing company

This avoids blocking portability on a future runtime `teams` model.

Imported-team tracking should initially be package/provenance-based:

- if a team package was imported, the imported agents should carry enough provenance to reconstruct that grouping
- Paperclip can treat “this set of agents came from team package X” as the imported-team model
- provenance grouping is the intended near- and medium-term team model for import/export
- only add a first-class runtime `teams` table later if product needs move beyond what provenance grouping can express

### 6.3 Dependency Graph

Import should operate on an entity graph, not raw file selection.

Examples:

- selecting an agent auto-selects its required docs and skill refs
- selecting a team auto-selects its subtree
- selecting a company auto-selects all included entities by default
- selecting a project auto-selects its starter tasks

The preview output should reflect graph resolution explicitly.

## 7. External References, Pinning, And Attribution

### 7.1 Why This Matters

Some packages will:

- reference upstream files we do not want to republish
- include third-party work where attribution must remain visible
- need protection from branch hot-swapping

### 7.2 Policy

Paperclip should support source references in package metadata with:

- repo
- path
- commit sha
- optional blob sha
- optional sha256
- attribution
- license
- usage mode

Usage modes:

- `vendored`
- `referenced`
- `mirrored`

Default exporter behavior for third-party content should be:

- prefer `referenced`
- preserve attribution
- do not silently inline third-party content into exports

### 7.3 Trust Model

Imported package content should be classified by trust level:

- markdown-only
- markdown + assets
- markdown + scripts/executables

The UI and CLI should surface this clearly before apply.

## 8. Import Behavior

### 8.1 Supported Sources

- local folder
- local package root file
- GitHub repo URL
- GitHub subtree URL
- direct URL to markdown/package root

Registry-based discovery may be added later, but must remain optional.

### 8.2 Import Targets

- new company
- existing company

For existing company imports, the preview must support:

- collision handling
- attach-point selection for team imports
- selective entity import

### 8.3 Collision Strategy

Current `rename | skip | replace` support remains, but matching should improve over time.

Preferred matching order:

1. prior install provenance
2. stable package entity identity
3. slug
4. human name as weak fallback

Slug-only matching is acceptable only as a transitional strategy.

### 8.4 Required Preview Output

Every import preview should surface:

- target company action
- entity-level create/update/skip plan
- referenced external content
- missing files
- hash mismatch or pinning issues
- env inputs, including required vs optional and default values when present
- unsupported content types
- trust/licensing warnings

### 8.5 Adapter Skill Sync Surface

People want skill management in the UI, but skills are adapter-dependent.

That means portability and UI planning must include an adapter capability model for skills.

Paperclip should define a new adapter surface area around skills:

- list currently enabled skills for an agent
- report how those skills are represented by the adapter
- install or enable a skill
- disable or remove a skill
- report sync state between desired package config and actual adapter state

Examples:

- Claude Code / Codex style adapters may manage skills as local filesystem packages or adapter-owned skill directories
- OpenClaw-style adapters may expose currently enabled skills through an API or a reflected config surface
- some adapters may be read-only and only report what they have

Planned adapter capability shape:

- `supportsSkillRead`
- `supportsSkillWrite`
- `supportsSkillRemove`
- `supportsSkillSync`
- `skillStorageKind` such as `filesystem`, `remote_api`, `inline_config`, or `unknown`

Baseline adapter interface:

- `listSkills(agent)`
- `applySkills(agent, desiredSkills)`
- `removeSkill(agent, skillId)` optional
- `getSkillSyncState(agent, desiredSkills)` optional

Planned Paperclip behavior:

- if an adapter supports read, Paperclip should show current skills in the UI
- if an adapter supports write, Paperclip should let the user enable/disable imported skills
- if an adapter supports sync, Paperclip should compute desired vs actual state and offer reconcile actions
- if an adapter does not support these capabilities, the UI should still show the package-level desired skills but mark them unmanaged

## 9. Export Behavior

### 9.1 Default Export Target

Default export target should become a markdown-first folder structure.

Example:

```text
my-company/
├── COMPANY.md
├── agents/
├── teams/
└── skills/
```

### 9.2 Export Rules

Exports should:

- omit machine-local ids
- omit timestamps and counters unless explicitly needed
- omit secret values
- omit local absolute paths
- omit duplicated inline prompt content from `.paperclip.yaml` when `AGENTS.md` already carries the instructions
- preserve references and attribution
- emit `.paperclip.yaml` alongside the base package
- express adapter env/secrets as portable env input declarations rather than exported secret binding ids
- preserve compatible `SKILL.md` content as-is

Projects and issues should not be exported by default.

They should be opt-in through selectors such as:

- `--projects project-shortname-1,project-shortname-2`
- `--issues PAP-1,PAP-3`
- `--project-issues project-shortname-1,project-shortname-2`

This supports “clean public company package” workflows where a maintainer exports a follower-facing company package without bundling active work items every time.

### 9.3 Export Units

Initial export units:

- company package
- team package
- single agent package

Later optional units:

- skill pack export
- seed projects/tasks bundle

## 10. Storage Model Inside Paperclip

### 10.1 Short-Term

In the first phase, imported entities can continue mapping onto current runtime tables:

- company -> companies
- agent -> agents
- team -> imported agent subtree attachment plus package provenance grouping
- skill -> company-scoped reusable package metadata plus agent-scoped desired-skill attachment state where supported

### 10.2 Medium-Term

Paperclip should add managed package/provenance records so imports are not anonymous one-off copies.

Needed capabilities:

- remember install origin
- support re-import / upgrade
- distinguish local edits from upstream package state
- preserve external refs and package-level metadata
- preserve imported team grouping without requiring a runtime `teams` table immediately
- preserve desired-skill state separately from adapter runtime state
- support both company-scoped reusable skills and agent-scoped skill attachments

Suggested future tables:

- package_installs
- package_install_entities
- package_sources
- agent_skill_desires
- adapter_skill_snapshots

This is not required for phase 1 UI, but it is required for a robust long-term system.

## 11. API Plan

### 11.1 Keep Existing Endpoints Initially

Retain:

- `POST /api/companies/:companyId/export`
- `POST /api/companies/import/preview`
- `POST /api/companies/import`

But evolve payloads toward the markdown-first graph model.

### 11.2 New API Capabilities

Add support for:

- package root resolution from local/GitHub inputs
- graph resolution preview
- source pin and hash verification results
- entity-level selection
- team attach target selection
- provenance-aware collision planning

### 11.3 Parsing Changes

Replace the current ad hoc markdown frontmatter parser with a real parser that can handle:

- nested YAML
- arrays/objects reliably
- consistent round-tripping

This is a prerequisite for the new package model.

## 12. CLI Plan

The CLI should continue to support direct import/export without a registry.

Target commands:

- `paperclipai company export <company-id> --out <path>`
- `paperclipai company import <path-or-url> --dry-run`
- `paperclipai company import <path-or-url> --target existing -C <company-id>`

Planned additions:

- `--package-kind company|team|agent`
- `--attach-under <agent-id-or-slug>` for team imports
- `--strict-pins`
- `--allow-unpinned`
- `--materialize-references`
- `--sync-skills`

## 13. UI Plan

### 13.1 Company Settings Import / Export

Add a real import/export section to Company Settings.

Export UI:

- export package kind selector
- include options
- local download/export destination guidance
- attribution/reference summary

Import UI:

- source entry:
  - upload/folder where supported
  - GitHub URL
  - generic URL
- preview pane with:
  - resolved package root
  - dependency tree
  - checkboxes by entity
  - trust/licensing warnings
  - secrets requirements
  - collision plan

### 13.2 Team Import UX

If importing a team into an existing company:

- show the subtree structure
- require the user to choose where to attach it
- preview manager/reporting updates before apply
- preserve imported-team provenance so the UI can later say “these agents came from team package X”

### 13.3 Skills UX

See also:

- `doc/plans/2026-03-14-skills-ui-product-plan.md`

If importing skills:

- show whether each skill is local, vendored, or referenced
- show whether it contains scripts/assets
- preserve Agent Skills compatibility in presentation and export
- preserve `skills.sh` compatibility in both import and install flows
- show agent skill attachments by shortname/slug rather than noisy file paths
- treat agent skills as a dedicated agent tab, not just another subsection of configuration
- show current adapter-reported skills when supported
- show desired package skills separately from actual adapter state
- offer reconcile actions when the adapter supports sync

## 14. Rollout Phases

### Phase 1: Stabilize Current V1 Portability

- add tests for current portability flows
- replace the frontmatter parser
- add Company Settings UI for current import/export capabilities
- start cutover work toward the markdown-first package reader

### Phase 2: Markdown-First Package Reader

- support `COMPANY.md` / `TEAM.md` / `AGENTS.md` root detection
- build internal graph from markdown-first packages
- support local folder and GitHub repo inputs natively
- support agent skill references by shortname/slug
- resolve local `skills/<slug>/SKILL.md` packages by convention
- support `skills.sh`-compatible skill repos as V1 package sources

### Phase 3: Graph-Based Import UX And Skill Surfaces

- entity tree preview
- checkbox selection
- team subtree attach flow
- licensing/trust/reference warnings
- company skill library groundwork
- dedicated agent `Skills` tab groundwork
- adapter skill read/sync UI groundwork

### Phase 4: New Export Model

- export markdown-first folder structure by default

### Phase 5: Provenance And Upgrades

- persist install provenance
- support package-aware re-import and upgrades
- improve collision matching beyond slug-only
- add imported-team provenance grouping
- add desired-vs-actual skill sync state

### Phase 6: Optional Seed Content

- goals
- projects
- starter issues/tasks

This phase is intentionally after the structural model is stable.

## 15. Documentation Plan

Primary docs:

- `docs/companies/companies-spec.md` as the package-format draft
- this implementation plan for rollout sequencing

Docs to update later as implementation lands:

- `doc/SPEC-implementation.md`
- `docs/api/companies.md`
- `docs/cli/control-plane-commands.md`
- board operator docs for Company Settings import/export

## 16. Open Questions

1. Should imported skill packages be stored as managed package files in Paperclip storage, or only referenced at import time?
   Decision: managed package files should support both company-scoped reuse and agent-scoped attachment.
2. What is the minimum adapter skill interface needed to make the UI useful across Claude Code, Codex, OpenClaw, and future adapters?
   Decision: use the baseline interface in section 8.5.
3. Should Paperclip support direct local folder selection in the web UI, or keep that CLI-only initially?
4. Do we want optional generated lock files in phase 2, or defer them until provenance work?
5. How strict should pinning be by default for GitHub references:
   - warn on unpinned
   - or block in normal mode
6. Is package-provenance grouping enough for imported teams, or do we expect product requirements soon that would justify a first-class runtime `teams` table?
   Decision: provenance grouping is enough for the import/export product model for now.

## 17. Recommendation

Engineering should treat this as the current plan of record for company import/export beyond the existing V1 portability feature.

Immediate next steps:

1. accept `docs/companies/companies-spec.md` as the package-format draft
2. implement phase 1 stabilization work
3. build phase 2 markdown-first package reader before expanding ClipHub or `companies.sh`
4. treat the old manifest-based format as deprecated and not part of the future surface

This keeps Paperclip aligned with:

- GitHub-native distribution
- Agent Skills compatibility
- a registry-optional ecosystem model
