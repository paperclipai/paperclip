# Coordinator Inbox manual test

Open [Inbox Test Drive](http://127.0.0.1:3917/IBX/decisions). The local board user has one launch approval. Two synthetic agents have hit the same provider account’s five-hour limit on four tasks, three failed attempts per task. The fixture uses recorded provider outcomes. No model account is needed.

Run the following commands from the root of this checkout. Define this shell function once.

```sh
inbox_demo() {
  node --import ./server/node_modules/tsx/dist/loader.mjs server/scripts/inbox-test-drive.ts "$1"
}
```

| Step | Action | Expected result |
| --- | --- | --- |
| 1 | Run `inbox_demo reset` and reload **Needs you**. | One launch approval, sidebar badge **1**, and **Waiting · 1**. |
| 2 | Open **Waiting** and expand **View 4 tasks**. Follow a run log, then go back. | One usage-limit row, a retry time, four task links, agent names, and individual run links. **History** contains the twelve failed runs. |
| 3 | In **Needs you**, click **Archive for me** on the approval. Reload. Open **View → Archived** and restore it from its menu. Archive it again and click **Undo** in the toast. | Archiving clears the badge and survives reload. Restore and Undo each bring back the pending approval. |
| 4 | On the approval, choose **⋯ → Snooze for me → Tomorrow morning**. | **Needs you** is empty, the badge clears, and **Waiting** contains the snoozed approval and the provider limit. |
| 5 | In **Waiting**, archive the provider limit. Run `inbox_demo repeat` and refresh. | A fifth task has hit the same limit. The episode stays archived and only the snoozed approval remains in Waiting. Open **View → Archived** to inspect the expanded group. |
| 6 | Run `inbox_demo one-left`, open **Needs you**, and refresh. | The episode returns as **1 task needs a retry after the usage limit**. The badge is **1**. **Open task to retry** leads to IBX-4. |
| 7 | Run `inbox_demo all-recovered` and refresh **Needs you**. | The retry row clears automatically. The badge clears. In **History**, IBX-1 shows **Work resumed** and IBX-4 shows **Task completed**. |
| 8 | In **Waiting**, open the snoozed approval’s menu and choose **Restore now**. Go to **Needs you** and approve the launch plan. | The approval leaves the inbox, the badge clears, and the decision appears in **History**. |
| 9 | Run `inbox_demo reset` and refresh. | The original approval and four-task waiting group are ready for another pass. |

The fixture commands write synthetic outcomes directly into the isolated embedded database, so refresh after running one. Actions taken in the UI update the inbox immediately. Reset targets the fixture company in this checkout’s `tmp/inbox-drive` database and clears the local board user’s dismissals for that company.

## Restart the local server

From this checkout, with port 3917 free, run the following in a terminal and leave it open.

```sh
env -u DATABASE_URL -u DATABASE_MIGRATION_URL -u PAPERCLIP_CONFIG \
  PAPERCLIP_HOME="$PWD/tmp/inbox-drive" PAPERCLIP_INSTANCE_ID=default \
  PAPERCLIP_DISABLE_CWD_ENV_FILE=true PAPERCLIP_UI_DEV_MIDDLEWARE=true \
  PAPERCLIP_MIGRATION_AUTO_APPLY=true PAPERCLIP_OPEN_ON_LISTEN=false \
  PAPERCLIP_TELEMETRY_DISABLED=1 PAPERCLIP_DEPLOYMENT_MODE=local_trusted \
  HOST=127.0.0.1 PAPERCLIP_BIND=loopback HEARTBEAT_SCHEDULER_ENABLED=false PORT=3917 \
  pnpm --filter @paperclipai/server exec tsx watch src/index.ts
```
