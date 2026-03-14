# 資料庫

Paperclip 透過 [Drizzle ORM](https://orm.drizzle.team/) 使用 PostgreSQL。運行資料庫的方法有三種，從最簡單到最適合生產。

## 1. 內嵌 PostgreSQL — 零配置

如果不設定`DATABASE_URL`，伺服器會自動啟動一個嵌入的PostgreSQL實例並管理本機資料目錄。

```sh
pnpm dev
```

就是這樣。首次啟動伺服器時：

1. 創建`~/.paperclip/instances/default/db/`目錄用於存儲
2. 確保`paperclip`資料庫存在
3. 對空資料庫自動運行遷移
4. 開始處理請求

重新啟動後資料仍保留在 `~/.paperclip/instances/default/db/` 中。若要重設本機開發數據，請刪除該目錄。

如果您需要手動套用掛起的遷移，請執行：

```sh
pnpm db:migrate
```

當 `DATABASE_URL` 未設定時，此指令針對活動 Paperclip 設定/實例的目前嵌入 PostgreSQL 實例。

此模式非常適合本地開發和單命令安裝。

Docker 注意：Docker 快速入門映像預設也使用嵌入的 PostgreSQL。保留 `/paperclip` 以在容器重新啟動時保留資料庫狀態（請參閱 `doc/DOCKER.md`）。

## 2.本地PostgreSQL (Docker)

對於本地完整的 PostgreSQL 伺服器，請使用隨附的 Docker Compose 設定：

```sh
docker compose up -d
```

這將在 `localhost:5432` 上啟動 PostgreSQL 17。然後設定連接字串：

```sh
cp .env.example .env
# .env already contains:
# DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
```

運行遷移（一旦遷移產生問題解決）或使用 `drizzle-kit push`：

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  npx drizzle-kit push
```

啟動伺服器：

```sh
pnpm dev
```

## 3. 託管PostgreSQL (Supabase)

對於生產，請使用託管 PostgreSQL 提供者。 [Supabase](https://supabase.com/) 是一個不錯的選擇，具有免費套餐。

### 設定

1. 在[database.new](https://database.new)建立一個項目
2. 前往 **項目設定 > 資料庫 > 連接字串**
3. 複製 URI 並將密碼佔位符替換為您的資料庫密碼

### 連接字串

Supabase提供兩種連接方式：

**直接連接**（連接埠 5432）- 用於遷移和一次性腳本：

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

**透過 Supavisor 進行連接池**（連接埠 6543）— 用於應用程式：

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
```

### 配置

在您的 `.env` 中設定 `DATABASE_URL`：

```sh
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
```

如果使用連線池（連接埠 6543），`postgres` 用戶端必須停用準備好的語句。更新`packages/db/src/client.ts`：

```ts
export function createDb(url: string) {
  const sql = postgres(url, { prepare: false });
  return drizzlePg(sql, { schema });
}
```

### 推送模式

```sh
# Use the direct connection (port 5432) for schema changes
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@...5432/postgres \
  npx drizzle-kit push
```

### 免費等級限制

- 500 MB 資料庫存儲
- 200個並發連接
- 項目在 1 週不活動後暫停

有關當前詳細信息，請參閱 [Supabase 定價](https://supabase.com/pricing)。

## 模式切換

資料庫模式由`DATABASE_URL`控制：| `DATABASE_URL` |模式|
|---|---|
|未設定 |嵌入式 PostgreSQL (`~/.paperclip/instances/default/db/`) |
| `postgres://...localhost...` |本地 Docker PostgreSQL |
| `postgres://...supabase.com...` |主辦 Supabase |

無論模式為何，您的 Drizzle 架構 (`packages/db/src/schema/`) 都保持不變。

## 秘密存儲

Paperclip 將秘密元資料和版本儲存在：

- `company_secrets`
- `company_secret_versions`

對於本地/預設安裝，活動提供者是 `local_encrypted`：

- 秘密資料使用本機主金鑰進行靜態加密。
- 預設金鑰檔案：`~/.paperclip/instances/default/secrets/master.key`（如果遺失則會自動建立）。
- CLI 設定位置：`secrets.localEncrypted.keyFilePath` 下的 `~/.paperclip/instances/default/config.json`。

可選覆蓋：

- `PAPERCLIP_SECRETS_MASTER_KEY`（32 位元組金鑰為 base64、十六進位或原始 32 字元字串）
- `PAPERCLIP_SECRETS_MASTER_KEY_FILE`（自訂金鑰檔案路徑）

嚴格模式阻止新的內聯敏感環境值：

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

您可以透過以下方式設定嚴格模式和提供者預設值：

```sh
pnpm paperclipai configure --section secrets
```

內嵌秘密遷移命令：

```sh
pnpm secrets:migrate-inline-env --apply
```