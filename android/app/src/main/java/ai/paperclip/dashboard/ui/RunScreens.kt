@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package ai.paperclip.dashboard.ui

import ai.paperclip.dashboard.data.Agent
import ai.paperclip.dashboard.data.HeartbeatRun
import ai.paperclip.dashboard.data.LiveEvent
import ai.paperclip.dashboard.data.PaperclipApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.SecondaryTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

val ACTIVE_RUN_STATUSES = setOf("queued", "running", "starting", "scheduled_retry")

fun JsonObject.s(key: String): String? = (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull

/**
 * Subscribes to the company live-event socket while in composition and calls [onEvent] on the
 * main thread. Reconnects with backoff, like the web LiveUpdatesProvider.
 */
@Composable
fun LiveEvents(api: PaperclipApi, companyId: String, onEvent: (LiveEvent) -> Unit) {
    val handler by rememberUpdatedState(onEvent)
    val scope = rememberCoroutineScope()
    DisposableEffect(companyId) {
        var socket: WebSocket? = null
        var closed = false
        var attempt = 0
        lateinit var connect: () -> Unit
        val retry = {
            if (!closed) scope.launch {
                delay((1000L shl attempt.coerceAtMost(5)).coerceAtMost(30_000))
                attempt++
                if (!closed) connect()
            }
        }
        connect = {
            socket = api.liveEvents(companyId, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) { attempt = 0 }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    val ev = runCatching { api.json.decodeFromString(LiveEvent.serializer(), text) }.getOrNull() ?: return
                    scope.launch { handler(ev) }
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { retry() }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { retry() }
            })
        }
        connect()
        onDispose { closed = true; socket?.close(1000, null) }
    }
}

@Composable
fun RunRow(run: HeartbeatRun, agentsById: Map<String, Agent>, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                run.agentName ?: agentsById[run.agentId]?.name ?: "Agent",
                style = MaterialTheme.typography.titleSmall,
            )
            Text(
                listOfNotNull(run.invocationSource?.let(::humanize), run.triggerDetail, relativeTime(run.startedAt ?: run.createdAt))
                    .joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            run.error?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        Spacer(Modifier.width(8.dp))
        StatusPill(run.status)
    }
}

/** Company-wide run history (web /activity/runs) or one agent's runs. Updates live. */
@Composable
fun RunsScreen(api: PaperclipApi, companyId: String, agentsById: Map<String, Agent>, agentId: String? = null, onOpen: (HeartbeatRun) -> Unit) {
    var filter by remember { mutableStateOf("all") }
    val state = rememberLoad(companyId, agentId) { api.runs(companyId, agentId, 200) }
    LiveEvents(api, companyId) { ev ->
        if (ev.type == "heartbeat.run.queued" || ev.type == "heartbeat.run.status") state.reload()
    }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (f in listOf("all", "active", "failed")) {
                FilterChip(selected = filter == f, onClick = { filter = f }, label = { Text(humanize(f)) })
            }
        }
        LoadedContent(state) { runs ->
            val shown = when (filter) {
                "active" -> runs.filter { it.status in ACTIVE_RUN_STATUSES }
                "failed" -> runs.filter { it.status == "failed" || it.status == "timed_out" }
                else -> runs
            }
            if (shown.isEmpty()) EmptyState("No runs")
            else LazyColumn(Modifier.fillMaxSize()) {
                items(shown, key = { it.id }) { RunRow(it, agentsById) { onOpen(it) } }
            }
        }
    }
}

/** Agents working right now (web /dashboard/live), with their latest progress line. */
@Composable
fun LiveRunsScreen(api: PaperclipApi, companyId: String, agentsById: Map<String, Agent>, onOpen: (HeartbeatRun) -> Unit) {
    val state = rememberLoad(companyId) { api.liveRuns(companyId) }
    val progress = remember { mutableStateMapOf<String, String>() }
    LiveEvents(api, companyId) { ev ->
        when (ev.type) {
            "heartbeat.run.progress" -> {
                val id = ev.payload.s("runId") ?: return@LiveEvents
                val line = listOfNotNull(ev.payload.s("currentToolName")?.let { "⚙ $it" }, ev.payload.s("lastAssistantSnippet") ?: ev.payload.s("message"))
                    .joinToString("  ")
                if (line.isNotBlank()) progress[id] = line
            }
            "heartbeat.run.queued", "heartbeat.run.status" -> state.reload()
        }
    }
    LoadedContent(state) { runs ->
        if (runs.isEmpty()) EmptyState("No agents are working right now")
        else LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(runs, key = { it.id }) { run ->
                OutlinedCard(Modifier.fillMaxWidth().clickable { onOpen(run) }) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(run.agentName ?: agentsById[run.agentId]?.name ?: "Agent", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                            StatusPill(run.status)
                        }
                        Text(
                            "Started ${relativeTime(run.startedAt ?: run.createdAt)}" + (run.livenessState?.let { " · ${humanize(it)}" } ?: ""),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        progress[run.id]?.let {
                            Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
    }
}

private data class LogLine(val stream: String, val text: String)

private fun parseLogContent(content: String): List<LogLine> = content.lineSequence().filter { it.isNotBlank() }.map { line ->
    runCatching {
        val o = kotlinx.serialization.json.Json.parseToJsonElement(line) as JsonObject
        LogLine(o.s("stream") ?: "stdout", o.s("chunk") ?: "")
    }.getOrElse { LogLine("stdout", line) }
}.toList()

/** One readable block of a run transcript: agent text, a thought, a tool call, the result, or a raw line. */
internal data class TranscriptEntry(val kind: String, val title: String?, val text: String)

/**
 * Turns adapter NDJSON (acpx.* events, one JSON object per line, possibly split across log chunks)
 * into transcript blocks the way the web run view does. Consecutive text deltas with the same tag merge.
 * Unknown lines stay as raw text so nothing is hidden.
 */
internal fun buildTranscript(lines: List<Pair<String, String>>): List<TranscriptEntry> {
    val out = mutableListOf<TranscriptEntry>()
    fun add(kind: String, title: String?, text: String) {
        val last = out.lastOrNull()
        if (last != null && last.kind == kind && last.title == title && (kind == "message" || kind == "thought" || kind == "raw")) {
            out[out.size - 1] = last.copy(text = last.text + text)
        } else out += TranscriptEntry(kind, title, text)
    }
    val buffer = StringBuilder()
    fun flush(line: String, stream: String) {
        if (line.isBlank()) return
        val o = runCatching { kotlinx.serialization.json.Json.parseToJsonElement(line) as? JsonObject }.getOrNull()
        val type = o?.s("type")
        when {
            o == null || type == null -> add(if (stream == "stderr") "stderr" else "raw", null, line + "\n")
            type == "acpx.text_delta" -> add(if (o.s("tag") == "agent_thought_chunk") "thought" else "message", null, o.s("text").orEmpty())
            type == "acpx.tool_call" -> {
                val name = o.s("name") ?: o.s("title") ?: "tool"
                val status = o.s("status")
                val id = o.s("toolCallId")
                // Tool updates repeat the same call id; keep one block and refresh its status.
                val idx = out.indexOfLast { it.kind == "tool" && id != null && it.title?.endsWith("#$id") == true }
                val body = o.s("text") ?: o["input"]?.toString().orEmpty()
                val entry = TranscriptEntry("tool", "$name${status?.let { " · $it" } ?: ""}#${id ?: out.size}", body)
                if (idx >= 0) out[idx] = entry.copy(text = body.ifBlank { out[idx].text }) else out += entry
            }
            type == "acpx.result" -> add("result", o.s("stopReason"), o.s("summary") ?: o.s("message") ?: "finished")
            type == "acpx.status" && o.s("tag") == "usage_update" -> Unit
            type == "acpx.status" -> add("status", null, (o.s("text") ?: "") + "\n")
            type.startsWith("acpx.error") || o.s("level") == "error" -> add("stderr", null, (o.s("text") ?: o.s("message") ?: line) + "\n")
            else -> add("raw", null, (o.s("text") ?: line) + "\n")
        }
    }
    for ((stream, chunk) in lines) {
        buffer.append(chunk)
        var nl = buffer.indexOf("\n")
        while (nl >= 0) {
            flush(buffer.substring(0, nl), stream)
            buffer.delete(0, nl + 1)
            nl = buffer.indexOf("\n")
        }
        // A chunk without a trailing newline that is already a whole JSON object is complete.
        if (buffer.isNotEmpty() && buffer.startsWith("{") && buffer.endsWith("}") &&
            runCatching { kotlinx.serialization.json.Json.parseToJsonElement(buffer.toString()) }.isSuccess) {
            flush(buffer.toString(), stream); buffer.clear()
        }
    }
    if (buffer.isNotEmpty()) flush(buffer.toString(), "stdout")
    return out
}

/** Run detail (web agents/:id/runs/:runId): status, cancel, linked tasks, events and a live-tailing log. */
@Composable
fun RunDetailScreen(api: PaperclipApi, companyId: String, runId: String, agentsById: Map<String, Agent>, onOpenIssue: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    val state = rememberLoad(runId) { api.run(runId) }
    val issues = rememberLoad(runId) { runCatching { api.runIssues(runId) }.getOrDefault(emptyList()) }
    val events = rememberLoad(runId) { runCatching { api.runEvents(runId) }.getOrDefault(emptyList()) }
    val log = remember(runId) { mutableStateListOf<LogLine>() }
    var logError by remember(runId) { mutableStateOf<String?>(null) }
    var tab by remember { mutableIntStateOf(0) }
    var busy by remember { mutableStateOf(false) }
    var actionError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(runId) {
        // Page through the stored log; live chunks arrive over the socket afterwards.
        try {
            var offset = 0L
            while (true) {
                val page = api.runLog(runId, offset)
                log += parseLogContent(page.content)
                offset = page.nextOffset ?: break
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            logError = e.message
        }
    }
    LiveEvents(api, companyId) { ev ->
        if (ev.payload.s("runId") != runId) return@LiveEvents
        when (ev.type) {
            "heartbeat.run.log" -> log += LogLine(ev.payload.s("stream") ?: "stdout", ev.payload.s("chunk") ?: "")
            "heartbeat.run.status" -> state.reload()
            "heartbeat.run.event" -> events.reload()
        }
    }

    LoadedContent(state) { run ->
        Column(Modifier.fillMaxSize()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(agentsById[run.agentId]?.name ?: "Run", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                    StatusPill(run.status)
                }
                Text(
                    listOfNotNull(
                        run.invocationSource?.let(::humanize),
                        run.startedAt?.let { "started ${relativeTime(it)}" },
                        run.finishedAt?.let { "finished ${relativeTime(it)}" },
                        run.exitCode?.let { "exit $it" },
                    ).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                run.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                if (run.redacted) Text("Run details are hidden from you.", style = MaterialTheme.typography.bodySmall)
                if (run.status in ACTIVE_RUN_STATUSES) {
                    OutlinedButton(enabled = !busy, onClick = {
                        busy = true
                        scope.launch {
                            actionError = runCatching { api.cancelRun(runId) }.exceptionOrNull()?.message
                            busy = false
                            state.reload()
                        }
                    }) { Text("Cancel run") }
                }
                actionError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                issues.data?.forEach { issue ->
                    TextButton(onClick = { onOpenIssue(issue.id) }) {
                        Text("${issue.identifier ?: ""} ${issue.title}".trim(), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            SecondaryTabRow(selectedTabIndex = tab) {
                Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("Transcript") })
                Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("Events") })
                Tab(selected = tab == 2, onClick = { tab = 2 }, text = { Text("Raw log") })
            }
            if (tab == 0) {
                // ponytail: rebuilds the whole transcript per new chunk; fine for normal runs, make incremental if huge logs lag.
                val transcript = remember(log.size) { buildTranscript(log.map { it.stream to it.text }) }
                val listState = rememberLazyListState()
                LaunchedEffect(transcript.size) { if (transcript.isNotEmpty()) listState.scrollToItem(transcript.size - 1) }
                logError?.let { ErrorBanner(it) }
                if (transcript.isEmpty()) EmptyState(if (run.status in ACTIVE_RUN_STATUSES) "Waiting for output…" else "No log output")
                else LazyColumn(Modifier.fillMaxSize(), state = listState, contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(transcript.size) { i -> TranscriptBlock(transcript[i]) }
                }
            } else if (tab == 2) {
                val listState = rememberLazyListState()
                LaunchedEffect(log.size) { if (log.isNotEmpty()) listState.scrollToItem(log.size - 1) }
                logError?.let { ErrorBanner(it) }
                if (log.isEmpty()) EmptyState(if (run.status in ACTIVE_RUN_STATUSES) "Waiting for output…" else "No log output")
                else LazyColumn(Modifier.fillMaxSize(), state = listState, contentPadding = PaddingValues(12.dp)) {
                    items(log.size) { i ->
                        val l = log[i]
                        Text(
                            l.text.trimEnd(),
                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                            color = when (l.stream) {
                                "stderr" -> MaterialTheme.colorScheme.error
                                "system" -> MaterialTheme.colorScheme.tertiary
                                else -> Color.Unspecified
                            },
                        )
                    }
                }
            } else {
                val list = events.data.orEmpty()
                if (list.isEmpty()) EmptyState("No events")
                else LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(list, key = { it.seq }) { e ->
                        Column {
                            Text("${humanize(e.eventType)} · ${relativeTime(e.createdAt)}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            e.message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TranscriptBlock(e: TranscriptEntry) {
    val mono = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)
    when (e.kind) {
        "message" -> Markdown(e.text.trim())
        "thought" -> Text(e.text.trim(), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        "tool" -> OutlinedCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(e.title.orEmpty().substringBeforeLast("#"), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.tertiary)
                if (e.text.isNotBlank()) Text(e.text.trim().take(2000), style = mono, maxLines = 12, overflow = TextOverflow.Ellipsis)
            }
        }
        "result" -> Text("Finished: ${e.text}" + (e.title?.let { " ($it)" } ?: ""), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
        "status" -> Text(e.text.trim(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        "stderr" -> Text(e.text.trimEnd(), style = mono, color = MaterialTheme.colorScheme.error)
        else -> Text(e.text.trimEnd(), style = mono)
    }
}
