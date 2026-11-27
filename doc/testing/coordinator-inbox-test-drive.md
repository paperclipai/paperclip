# Coordinator Inbox manual test

Open [Inbox Test Drive](http://127.0.0.1:3917/IBX/decisions). The local board user has one launch approval. Two synthetic agents have hit the same provider account’s five-hour limit on four tasks, three failed attempts per task. The fixture uses recorded provider outcomes. No model account is needed.

Open a terminal at the root of this checkout. Paste the function below, press Return, and keep that terminal open for the walkthrough. Run each `inbox_demo` command there, then switch back to the browser and refresh.

```sh
inbox_demo() {
  node --import ./server/node_modules/tsx/dist/loader.mjs server/scripts/inbox-test-drive.ts "$1"
}
```

| Step | Action | Expected result |
| --- | --- | --- |
| 1 | Run `inbox_demo reset` and reload **Needs you**. | One launch approval, sidebar badge **1**, and **Waiting · 1**. |
| 2 | Open **Waiting** and expand **View 4 tasks**. Follow a run log, then go back. | One usage-limit row, a retry time, four task links, agent names, and individual run links. **History** contains the twelve failed runs. |
| 3 | In **Needs you**, open the approval’s **⋯** menu and choose **Archive for me**. Reload. Open **View → Archived** and restore it from its menu. Archive it again and click **Undo** in the toast. | Archiving clears the badge and survives reload. Restore and Undo each bring back the pending approval. |
| 4 | On the approval, choose **⋯ → Snooze for me → Tomorrow morning**. | **Needs you** is empty, the badge clears, and **Waiting** contains the snoozed approval and the provider limit. |
| 5 | Open [Waiting](http://127.0.0.1:3917/IBX/decisions?folder=waiting). On the card with **View 4 tasks**, choose **⋯ → Archive for me**. Once the card disappears, run `inbox_demo repeat` in the terminal. Open [Archived](http://127.0.0.1:3917/IBX/decisions?view=archived) and click **View 5 tasks**. | **IBX-5 Summarize test results** appears in the archived group. The repeat failure leaves the group archived. Waiting shows the approval if you snoozed it in step 4. |
| 6 | Run `inbox_demo one-left`, open **Needs you**, and refresh. | The episode returns as **1 task needs a retry after the usage limit**. The badge is **1**. **Open task to retry** leads to IBX-4. |
| 7 | Run `inbox_demo all-recovered` and refresh **Needs you**. | The retry row clears automatically. The badge clears. In **History**, IBX-1 shows **Work resumed** because its retry succeeded. Opening IBX-1 shows **Todo** because the task is still open and no run is active. IBX-4 shows **Task completed** in History. |
| 8 | In **Waiting**, open the snoozed approval’s menu and choose **Restore now**. Go to **Needs you** and approve the launch plan. | The approval leaves the inbox, the badge clears, and the decision appears in **History**. |
| 9 | Run `inbox_demo reset` and refresh. | The original approval and four-task waiting group are ready for another pass. |

The fixture commands write synthetic outcomes directly into the isolated embedded database, so refresh after running one. Actions taken in the UI update the inbox immediately. Reset targets the fixture company in this checkout’s `tmp/inbox-drive` database and clears the local board user’s dismissals for that company.

## Test retries with an unknown reset

These commands use a separate synthetic company. Refresh the page after each command.

1. Run `inbox_demo chains` and open [Retry Chain Test Drive → Waiting](http://127.0.0.1:3917/RCH/decisions?folder=waiting). Expand **3 tasks hit usage limits**. Each task has its own retry time and says **Reset time unknown**.
2. Archive **RCH-1** using its ellipsis menu. Run `inbox_demo chains-repeat`. Waiting still has two tasks. In **View → Archived**, RCH-1 now shows **4 attempts**.
3. Run `inbox_demo chains-exhausted`. Only RCH-1 appears in **Needs you**. The two other tasks remain in **Waiting**.
4. Run `inbox_demo chains-recovered`. RCH-2 leaves Waiting automatically. RCH-3 is the only waiting card. Run `inbox_demo chains` to reset this example.

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
