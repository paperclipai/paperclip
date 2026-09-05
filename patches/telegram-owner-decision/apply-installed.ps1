param(
  [string]$PaperclipRepo = "C:\Users\admin\Documents\Paperclip",
  [string]$PluginRoot = "C:\Users\admin\.paperclip\plugins\node_modules\paperclip-plugin-telegram"
)

$ErrorActionPreference = "Stop"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Read-Text([string]$Path) {
  [IO.File]::ReadAllText($Path)
}

function Write-Text([string]$Path, [string]$Value) {
  [IO.File]::WriteAllText($Path, $Value, $Utf8NoBom)
}

function Backup-Once([string]$Path) {
  $backup = "$Path.ownerdecision.source-control.bak"
  if (-not (Test-Path $backup)) {
    Copy-Item $Path $backup -Force
  }
}

function Replace-Required([string]$Text, [string]$Anchor, [string]$Replacement, [string]$Name) {
  if (-not $Text.Contains($Anchor)) {
    throw "ANCHOR_NOT_FOUND: $Name"
  }
  $Text.Replace($Anchor, $Replacement)
}

if (-not (Test-Path $PaperclipRepo)) { throw "PAPERCLIP_REPO_NOT_FOUND: $PaperclipRepo" }
if (-not (Test-Path $PluginRoot)) { throw "TELEGRAM_PLUGIN_NOT_FOUND: $PluginRoot" }

$packageJson = Get-Content (Join-Path $PluginRoot "package.json") -Raw | ConvertFrom-Json
if ($packageJson.name -ne "paperclip-plugin-telegram" -or $packageJson.version -ne "0.8.0") {
  throw "TELEGRAM_PLUGIN_PIN_MISMATCH: expected paperclip-plugin-telegram@0.8.0"
}

# Paperclip core: expose the existing interaction-created activity to plugins.
$constantsPath = Join-Path $PaperclipRepo "packages\shared\src\constants.ts"
$constants = Read-Text $constantsPath
if (-not $constants.Contains('"issue.thread_interaction.created"')) {
  Backup-Once $constantsPath
  $constants = Replace-Required $constants '  "issue.relations.updated",' "  `"issue.relations.updated`",`r`n  `"issue.thread_interaction.created`"," "Paperclip plugin event type"
  Write-Text $constantsPath $constants
}

$activityPath = Join-Path $PaperclipRepo "server\src\services\activity-log.ts"
$activity = Read-Text $activityPath
if (-not $activity.Contains('issue_thread_interaction_created: "issue.thread_interaction.created"')) {
  Backup-Once $activityPath
  $activity = Replace-Required $activity '  issue_blockers_updated: "issue.relations.updated",' "  issue_blockers_updated: `"issue.relations.updated`",`r`n  issue_thread_interaction_created: `"issue.thread_interaction.created`"," "Paperclip activity event mapping"
  Write-Text $activityPath $activity
}

# Telegram manifest: use the already-governed Paperclip interaction APIs.
$manifestPath = Join-Path $PluginRoot "dist\manifest.js"
$manifest = Read-Text $manifestPath
if (-not $manifest.Contains('"issue.interactions.read"')) {
  Backup-Once $manifestPath
  $manifest = Replace-Required $manifest '        "issue.comments.create",' "        `"issue.comments.create`",`r`n        `"issue.interactions.read`",`r`n        `"issue.interactions.respond`"," "Telegram interaction capabilities"
  Write-Text $manifestPath $manifest
}

$workerPath = Join-Path $PluginRoot "dist\worker.js"
$worker = Read-Text $workerPath

if (-not $worker.Contains('ctx.events.on("issue.thread_interaction.created"')) {
  Backup-Once $workerPath
  $eventAnchor = '        ctx.events.on("approval.created", async (event) => {'
  $eventBlock = @'
        ctx.events.on("issue.thread_interaction.created", async (event) => {
            const rt = ensureRuntime();
            if (!rt)
                return;
            const payload = event.payload ?? {};
            const interactionId = String(payload.interactionId ?? "");
            const issueId = event.entityId ? String(event.entityId) : "";
            if (!interactionId || !issueId || String(payload.interactionKind ?? "") !== "request_confirmation")
                return;
            if (!doneDedupe(`decision|${interactionId}`))
                return;
            try {
                const interactions = await ctx.issues.listInteractions(issueId, event.companyId);
                const interaction = interactions.find((value) => value.id === interactionId);
                if (!interaction || interaction.kind !== "request_confirmation" || interaction.status !== "pending")
                    return;
                if (interaction.effectiveResolverPolicy !== "board_only")
                    return;
                const issue = await ctx.issues.get(issueId, event.companyId);
                const issueLabel = issue?.identifier
                    ? `${issue.identifier}: ${issue.title}`
                    : issue?.title ?? "Owner decision";
                const prompt = String(interaction.payload?.prompt ?? interaction.title ?? interaction.summary ?? "Owner decision required");
                const details = String(interaction.payload?.detailsMarkdown ?? interaction.summary ?? "").trim();
                const lines = ["Owner decision required", "", issueLabel, prompt];
                if (details && details !== prompt)
                    lines.push("", details);
                await notify(ctx, rt, event, () => ({
                    text: lines.join("\n"),
                    options: {
                        inlineKeyboard: [[
                            { text: "Approve", callback_data: `decision_accept_${interactionId}` },
                            { text: "Revise", callback_data: `decision_revise_${interactionId}` },
                        ]],
                    },
                }), rt.config.approvalsChatId, rt.config.approvalsTopicId);
            }
            catch (err) {
                ctx.logger.error("Failed to forward Owner decision to Telegram", {
                    issueId,
                    interactionId,
                    error: String(err),
                });
            }
        });

'@
  $worker = Replace-Required $worker $eventAnchor ($eventBlock + $eventAnchor) "Telegram owner decision event handler"
}

if (-not $worker.Contains('data.startsWith("decision_accept_")')) {
  Backup-Once $workerPath
  $callbackAnchor = '    if (data.startsWith("approve_")) {'
  $callbackBlock = @'
    if (data.startsWith("decision_accept_") || data.startsWith("decision_revise_")) {
        const accept = data.startsWith("decision_accept_");
        const interactionId = data.replace(accept ? "decision_accept_" : "decision_revise_", "");
        if (!chatId || !messageId) {
            await answerCallbackQuery(ctx, token, query.id, "Decision context missing");
            return;
        }
        const mapping = await ctx.state.get({
            scopeKind: "instance",
            stateKey: `msg_${chatId}_${messageId}`,
        });
        const companyId = mapping?.companyId ? String(mapping.companyId) : null;
        const issueId = mapping?.entityType === "issue" && mapping?.entityId ? String(mapping.entityId) : null;
        if (!companyId || !issueId) {
            await answerCallbackQuery(ctx, token, query.id, "Decision context invalid");
            return;
        }
        try {
            const interactions = await ctx.issues.listInteractions(issueId, companyId);
            const interaction = interactions.find((value) => value.id === interactionId);
            if (!interaction || interaction.kind !== "request_confirmation" || interaction.status !== "pending" || interaction.effectiveResolverPolicy !== "board_only") {
                await answerCallbackQuery(ctx, token, query.id, "Decision is no longer pending");
                return;
            }
            const boardAccess = await loadBoardAccessState(ctx);
            const actorUserId = (!boardAccess.companyId || boardAccess.companyId === companyId)
                ? boardAccess.identity
                : null;
            if (!actorUserId) {
                await answerCallbackQuery(ctx, token, query.id, "Board identity is not configured");
                return;
            }
            const result = await ctx.issues.respondInteraction(issueId, interactionId, accept
                ? { action: "accept", actorUserId }
                : { action: "reject", actorUserId, reason: "Revision requested via Telegram" }, companyId);
            if (result?.applied === false) {
                await answerCallbackQuery(ctx, token, query.id, "Decision already resolved");
                return;
            }
            await answerCallbackQuery(ctx, token, query.id, accept ? "Approved" : "Revision requested");
            await editMessage(ctx, token, chatId, messageId, accept ? `Approved by ${actor}` : `Revision requested by ${actor}`, {});
        }
        catch (err) {
            ctx.logger.error("Telegram Owner decision callback failed", { interactionId, error: String(err) });
            await answerCallbackQuery(ctx, token, query.id, "Decision action failed");
        }
        return;
    }

'@
  $worker = Replace-Required $worker $callbackAnchor ($callbackBlock + $callbackAnchor) "Telegram owner decision callback"
}

# Normalize the earlier manual overlay to the current Paperclip resolver-policy vocabulary.
$worker = $worker.Replace('if(policy&&policy!=="human_only"&&policy!=="board_only")return;', 'if(policy&&policy!=="board_only")return;')
Write-Text $workerPath $worker

node --check $manifestPath
node --check $workerPath

Write-Host "TELEGRAM_OWNER_DECISION_PATCH=PASS"
