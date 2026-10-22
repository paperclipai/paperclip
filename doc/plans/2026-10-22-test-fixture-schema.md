# 测试 fixture 建表列表与查询脱节

- 日期：2026-10-22
- 状态：待处理
- 来源：`84c9b71` 修复 `TestGetApprovedApplies_*` 时的观察

## 问题

测试里每个用例手写一份 `AutoMigrate` 表列表：

```go
 db.AutoMigrate(
     &model.Sandbox{},
     &model.SandboxEngine{},
     &model.DataResource{},
     &model.ResourceSandboxApply{},
     &model.PushedData{},
 )
```

一旦查询新增 JOIN 或 model 新增引用，测试的建表列表**不会自动跟上**，
表现为多个测试同时挂在 `no such table: xxx`，而失败信息完全不指向真实原因。

## 规模（实测）

| 项 | 数量 |
|---|---|
| 含 `AutoMigrate` 的测试文件 | 51 |
| `AutoMigrate` 调用处数 | 97 |
| 通过 `openIsolatedTestDB` 开库的文件 | **仅 7** |
| 自己直接 `gorm.Open` 的文件 | 其余 44 |
| model struct 总数 | 33（32 个有 `TableName()`） |

关键：**已有统一入口 `openIsolatedTestDB`（`isolated_test_helper_test.go:11`），
但它只负责开库、不负责建表**。所以每个测试还得自己写 `AutoMigrate`。
这既是问题根源，也让修复变得可控 —— 只需在该函数里加建表逻辑。


## 已经踩过一次

修 `sourceType` 时给 `getApprovedAppliesLogic` 加了：

```sql
LEFT JOIN data_asset da ON da.id = r.asset_id AND da.deleted_at IS NULL
```

但没同步测试 fixture。SQLite 里没有 `data_asset` 表，直接报
`no such table: data_asset`。挂掉的是：

- `api/internal/logic/core`：7 个 `TestGetApprovedApplies_*`
- `api/internal/handler/core`：`TestGetApprovedAppliesHandler_FiltersBySandboxType`

这些测试的失败原因和审批过滤逻辑毫无关系，但看报错很难定位。

`84c9b71` 已补上 `&model.DataAsset{}`，但**只是补了这一次**，
机制上仍然会再犯。历史上已多次出现同类修复
（`f3253b1`、`b88244c` 等都动过测试建表）。

## 现有防线管不到这里

`cmd/schema-drift` 校验的是 Go model 与 `db/*.sql` 的列一致性。
测试 fixture 是 Go 代码里的 `AutoMigrate` 调用，不在它的检查范围内。

## 三个可选方向

### A. 统一建表入口（推荐）

往已有的 `openIsolatedTestDB` 里加集中建表，再让其余 44 个自建 `gorm.Open`
的测试改用它。

**前提已验证**：实测把 25 个 model 一次性 `AutoMigrate` 到同一个 SQLite
内存库，无冲突、无失败（`成功建表 25 个 model`）。

- 优点：一次建全，新增 model 只需改一处；彻底消灭这类失败
- 缺点：要动 44 个测试文件的开库方式（机械改动）
- 风险：低。已确认没有测试依赖「表不存在」（`no such table` 断言 0 处），
  也没有测试断言表数量（`HasTable`/`GetTables` 0 处）；
  且 `openIsolatedTestDB` 用 `t.Name()` 做 DSN，每个测试独立库，互不干扰
- 建议分批：先改 `api/internal/logic/core`，再扩到 handler/admin/system

### B. 扩展 schema-drift 覆盖测试 fixture

让 `cmd/schema-drift` 扫描 `_test.go` 里的 `AutoMigrate` 调用，
与查询中出现的表名比对，缺表就报错。

- 优点：不改动测试结构
- 缺点：需要静态分析 SQL 字符串里的表名，实现复杂、误报率高；
  动态拼接的查询无法覆盖
- 风险：高

### C. 不管

补一次算一次。

- 优点：零成本
- 缺点：下次改查询还会挂，且失败信息误导性强

## 建议

先做 A。它是唯一切断问题根源的做法，而且改动机械、可分批（先改
`api/internal/logic/core`，再扩到 handler / admin / system）。

## 验收标准

- `openIsolatedTestDB` 内部完成全量建表，调用方不再各自维护 `AutoMigrate` 列表
- `go test ./...` 全部通过
- 反向验证：给某查询故意加一个新表 JOIN 且不改 fixture，测试仍应通过
  （证明机制生效）
- 建议加一条约束：新增 model 后只改建表入口一处，且 `go test ./...` 无
  `no such table` 失败
