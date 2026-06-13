# Plugin Health Alert Runbook

## Route

```
GET /api/plugins/alerts/plugin-health
Authorization: Board session (instance admin)
```

Returns `{ status: "firing"|"ok", alerts: PluginHealthAlert[], checkedAt: string }`.

Each `PluginHealthAlert` carries:

| Field | Description |
|-------|-------------|
| `alertname` | Always `"PaperclipPluginError"` |
| `severity` | Always `"page"` |
| `pluginId` | UUID of the errored plugin row |
| `pluginKey` | Stable plugin key (e.g. `paperclip-plugin-alertmanager`) |
| `status` | Always `"error"` |
| `lastError` | Last recorded error message, or `null` |
| `summary` | Human-readable one-liner for the alert |
| `description` | Full description including last_error context |
| `updatedAt` | ISO 8601 timestamp of the last status change |

Only plugins with `plugins.status = 'error'` appear in the response; `ready`, `disabled`, and `paused` plugins are suppressed by the `listByStatus("error")` filter.

---

## Paging integration path

### Option A — Prometheus + Alertmanager (recommended for production)

1. **Create a Prometheus scrape job** that polls this endpoint:

   ```yaml
   # prometheus.yml
   scrape_configs:
     - job_name: paperclip_plugin_health
       scheme: https
       bearer_token: <board-session-token-or-service-account-token>
       static_configs:
         - targets: ['<paperclip-host>']
       metrics_path: /api/plugins/alerts/plugin-health
       # The route returns JSON, not Prometheus metrics format.
       # Use the json_exporter sidecar or a recording rule via remote_write.
   ```

   Or use a **JSON exporter / blackbox exporter** scrape that extracts
   `status == "firing"` and emits a gauge:

   ```yaml
   modules:
     plugin_health:
       metrics:
         - name: paperclip_plugin_health_firing
           type: gauge
           path: '{ .status }'
           help: "1 when any plugin is in error state"
           values:
             firing: 1
             ok: 0
   ```

2. **Alertmanager rule**:

   ```yaml
   - alert: PaperclipPluginError
     expr: paperclip_plugin_health_firing == 1
     for: 2m
     labels:
       severity: page
     annotations:
       summary: "A Paperclip plugin is in error state"
       runbook_url: "https://github.com/Blockcast/paperclip/blob/master/doc/plugins/PLUGIN_HEALTH_ALERT_RUNBOOK.md"
   ```

3. Alertmanager routes the alert to PagerDuty/Opsgenie/Slack via the
   existing `receivers` config in `alertmanager.yml`.

### Option B — Direct API poll from an on-call script

For environments without Prometheus, an on-call operator can call the
endpoint directly with a board token to see which plugins are errored:

```bash
curl -s -H "Cookie: <board-session>" \
  https://<host>/api/plugins/alerts/plugin-health | jq .
```

If `status == "firing"`, the `alerts[]` array lists every errored plugin
with its `pluginId`, `pluginKey`, and `lastError`.

---

## On-call response steps

1. **Identify the errored plugin** from `pluginKey` / `pluginId` in the alert payload.
2. **Check recent logs**: `GET /api/plugins/<pluginId>/logs` or view the Plugin
   dashboard in the Paperclip board UI → Plugins → *plugin name* → Logs.
3. **Attempt recovery**: `POST /api/plugins/<pluginId>/enable` (re-enables and
   reloads the worker) or restart the plugin from the UI.
4. **Escalate** if the plugin enters error state again within 10 minutes: check
   worker container logs, npm package integrity, and any upstream service the
   plugin depends on.
5. **Suppress false positives**: disabled/paused plugins are filtered out by the
   route; only plugins that were running and crashed appear as alerts.

---

## Suppression rules

The following plugin states do NOT appear in the alert payload and do NOT
trigger pages:

- `ready` — plugin is healthy
- `disabled` — intentionally disabled by an operator
- `upgrade_pending` — pending approval, not yet running
- `uninstalled` — removed from the registry

Only `error` state triggers a `"firing"` response.
