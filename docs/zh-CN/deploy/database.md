---
title: 数据库 (Database)
summary: 嵌入式的 PGlite 与 Docker 运行下的 Postgres 以及全托管云端库之争
---

Paperclip 底层完全依托使用 Drizzle ORM 作为通讯驱动来连接使用 PostgreSQL。在如何运行该系统的数据库后端上，您有三种截然不同的选项路子可走。

## 1. 嵌入式使用内置 PostgreSQL（系统默认方案）

全系列零配置。只要您不强行去设置系统的 `DATABASE_URL` 环境变量，那么服务器在后台点火时就会自动去带节奏一并拉起内置随包附赠的嵌入式版本 PostgreSQL 并实例化它跑起来。

```sh
pnpm dev
```

而在进行历史第一次初盘开机大建时，服务器将会循序渐进依次完成下列动作：

1. 创建并在后台建立 `~/.paperclip/instances/default/db/` 长效缓存目录以供落盘存入真实的二进制死库记录
2. 确保名为 `paperclip` 的数据库主表域空间确凿已经建库
3. 完全自动化跑一遍 migrations 数据迁移建表脚本 
4. 才正式开启对外开张口子接入监听接收所有的请求服务

其上全部的资料数据均能被抗断电长效横跨历次休眠重新重启留底存根。至于真遇到不得不“删库跑路”重来：则只需一句 `rm -rf ~/.paperclip/instances/default/db` 抹干净重来。

而且官方包里提供的 Docker 快跑预设环境也同样会省事地自动采用使用内嵌版的 PostgreSQL 这条路子。

## 2. 独立建本地的 PostgreSQL（藉由 Docker 跑路）

对于执意倾向在本地真正实打实开辟一条完整庞杂规模宏大正版 PostgreSQL 全量服务的信徒而言：

```sh
docker compose up -d
```

这句真言会在你的地盘上即刻全效马力拉着起动一台在 `localhost:5432` 监听口运转着的 PostgreSQL 17。切记顺手要把自己的直连大号参数配写进去给系统用：

```sh
cp .env.example .env
# 往里头塞一条: DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
```

随后就是手动去“吹一口气”强制推一把新表模式覆盖进去:

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  npx drizzle-kit push
```

## 3. 直接拥抱并完全依托云上的全托管式 PostgreSQL (以 Supabase 为例)

对付拿出去见光的正儿八经的大型商用级别生产环境方案，更应该干脆省事直接外包找那种正经像 [Supabase](https://supabase.com/) 这类全职数据库云托管供应商保平安。

1. 到 [database.new](https://database.new) 大厅新建拉去一条新派项目实例
2. 在该项目自身的底盘 Project Settings > Database 后台仪表板直接全量照抄原样端出一整个复制那条连接字符串指令 (connection string)
3. 在部署服务器您自身配置的 `.env` 中把 `DATABASE_URL` 指定并配置进去

值得留意的是，只有当推拉 migration 架构时必须要求使用**直连式原版握手通信（direct connection 位于端口 5432 外口）**，而应用程序在平日高频海量收发请求查库访问时更被建议推荐使用去走**连接池模式网络连接（pooled connection 常设在 6543 外埠口子）**。

而若万一你决定走了走全自动连接池的代理大坑，这也就逼得你不得不把代码改写，禁用掉原来原生 SQL 数据端提供的原本默认开着的参数执行预备语句 (prepared statements)：

```ts
// 存放于路径 packages/db/src/client.ts 的这一段
export function createDb(url: string) {
  const sql = postgres(url, { prepare: false });
  return drizzlePg(sql, { schema });
}
```

## 在各种模式间的取舍与跳换

| 最终系统里吃入的 `DATABASE_URL` 长成啥样 | 当前正启用的模式 |
|----------------|------|
| 完全没写或者没配置这玩意 | 则退回采用内嵌款随包带上的 PostgreSQL 阉割版 |
| `postgres://...localhost...` 这种本地网关开头 | 那说明你在用本地用 Docker 等等自行圈养拉扯长大的纯种 PostgreSQL |
| `postgres://...supabase.com...` 这类公网神圣不可直视的域头 | 那八成是花大价钱直接上云投奔的全套代运维云托管级原生派 (如 Supabase 等) |

不论模式怎么变幻，存放于 `packages/db/src/schema/` 底下的 Drizzle 这层核心驱动其本身的骨骼 schema 结构描述映射是永远都用不到被单独牵扯去重敲甚至发生形变的。  
