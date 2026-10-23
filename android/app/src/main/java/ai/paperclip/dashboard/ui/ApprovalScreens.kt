package ai.paperclip.dashboard.ui

import ai.paperclip.dashboard.data.APPROVAL_STATUSES
import ai.paperclip.dashboard.data.Agent
import ai.paperclip.dashboard.data.Approval
import ai.paperclip.dashboard.data.PaperclipApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

@Composable
fun ApprovalsScreen(api: PaperclipApi, companyId: String, agentsById: Map<String, Agent>, onOpen: (String) -> Unit) {
    var status by rememberSaveable { mutableStateOf<String?>("pending") }
    val state = rememberLoad(companyId, status) { api.approvals(companyId, status) }
    Column {
        Row(
            Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            APPROVAL_STATUSES.forEach { s ->
                FilterChip(selected = status == s, onClick = { status = s }, label = { Text(humanize(s)) })
            }
            FilterChip(selected = status == null, onClick = { status = null }, label = { Text("All") })
        }
        LoadedContent(state) { approvals ->
            if (approvals.isEmpty()) {
                LazyColumn(Modifier.fillMaxSize()) { item { EmptyState(if (status == "pending") "Nothing waiting on you" else "No approvals") } }
            } else {
                LazyColumn {
                    items(approvals.sortedByDescending { it.createdAt }, key = { it.id }) { a ->
                        Column(
                            Modifier.fillMaxWidth().clickable { onOpen(a.id) }.padding(horizontal = 16.dp, vertical = 12.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(approvalTitle(a), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                                StatusPill(a.status)
                            }
                            Text(
                                listOfNotNull(humanize(a.type), requester(a, agentsById), relativeTime(a.createdAt)).joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        HorizontalDivider()
                    }
                }
            }
        }
    }
}

private fun payloadString(a: Approval, vararg keys: String): String? =
    keys.firstNotNullOfOrNull { k -> (a.payload[k] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() } }

fun approvalTitle(a: Approval): String = payloadString(a, "title", "name", "summary", "reason") ?: humanize(a.type)

private fun requester(a: Approval, agentsById: Map<String, Agent>): String? =
    a.requestedByAgentId?.let { "by " + (agentsById[it]?.name ?: "agent") } ?: a.requestedByUserId?.let { "by board" }

private val prettyJson = Json { prettyPrint = true }

@Composable
fun ApprovalDetailScreen(api: PaperclipApi, approvalId: String, agentsById: Map<String, Agent>, onOpenIssue: (String) -> Unit = {}) {
    val state = rememberLoad(approvalId) { api.approval(approvalId) }
    val linked = rememberLoad(approvalId) { runCatching { api.approvalIssues(approvalId) }.getOrDefault(emptyList()) }
    val comments = rememberLoad(approvalId) { api.approvalComments(approvalId) }
    val scope = rememberCoroutineScope()
    var note by rememberSaveable { mutableStateOf("") }
    var comment by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun run(block: suspend () -> Unit, after: () -> Unit) {
        busy = true
        scope.launch {
            val r = runCatching { block() }
            error = r.exceptionOrNull()?.message
            busy = false
            if (r.isSuccess) after()
        }
    }

    LoadedContent(state, Modifier.imePadding()) { a ->
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(approvalTitle(a), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        StatusPill(a.status)
                        Text(listOfNotNull(humanize(a.type), requester(a, agentsById), relativeTime(a.createdAt)).joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    a.decisionNote?.let { Text("Decision note: $it", style = MaterialTheme.typography.bodyMedium) }
                }
            }
            item { PayloadCard(a.payload) }
            if (a.status == "pending" || a.status == "revision_requested") {
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(note, { note = it }, label = { Text("Decision note (optional)") }, modifier = Modifier.fillMaxWidth())
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(enabled = !busy, onClick = { run({ api.decideApproval(a.id, "approve", note) }) { note = ""; state.reload() } }) {
                                Text("Approve")
                            }
                            Button(
                                enabled = !busy,
                                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                                onClick = { run({ api.decideApproval(a.id, "reject", note) }) { note = ""; state.reload() } },
                            ) { Text("Reject") }
                        }
                        if (a.status == "pending") {
                            OutlinedButton(enabled = !busy, onClick = { run({ api.decideApproval(a.id, "request-revision", note) }) { note = ""; state.reload() } }) {
                                Text("Request revision")
                            }
                        }
                    }
                }
            }
            if (a.status == "revision_requested") {
                item {
                    OutlinedButton(enabled = !busy, onClick = { run({ api.resubmitApproval(a.id) }) { state.reload() } }) {
                        Text("Resubmit")
                    }
                }
            }
            error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
            linked.data?.takeIf { it.isNotEmpty() }?.let { issues ->
                item { Text("Linked tasks", style = MaterialTheme.typography.titleMedium) }
                items(issues, key = { "issue:" + it.id }) { i ->
                    Row(Modifier.fillMaxWidth().clickable { onOpenIssue(i.id) }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("${i.identifier ?: ""} ${i.title}".trim(), modifier = Modifier.weight(1f))
                        StatusPill(i.status)
                    }
                }
            }
            item { Text("Comments", style = MaterialTheme.typography.titleMedium) }
            val list = comments.data
            if (list == null) {
                item { Text(comments.error ?: "Loading…") }
            } else if (list.isEmpty()) {
                item { Text("No comments yet", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            } else {
                items(list, key = { it.id }) { c ->
                    CommentCard(c.authorAgentId?.let { agentsById[it]?.name ?: "Agent" } ?: "Board", c.createdAt, c.body)
                }
            }
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(comment, { comment = it }, placeholder = { Text("Add a comment") }, modifier = Modifier.weight(1f))
                    TextButton(enabled = comment.isNotBlank() && !busy, onClick = {
                        run({ api.addApprovalComment(a.id, comment.trim()) }) { comment = ""; comments.reload() }
                    }) { Text("Post") }
                }
            }
        }
    }
}

@Composable
private fun PayloadCard(payload: JsonObject) {
    if (payload.isEmpty()) return
    OutlinedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            payload.forEach { (key, value) ->
                Column {
                    Text(humanize(key), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (value is JsonPrimitive) {
                        Text(value.jsonPrimitive.contentOrNull ?: "—", style = MaterialTheme.typography.bodyMedium)
                    } else {
                        Text(
                            prettyJson.encodeToString(JsonElement.serializer(), value),
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                }
            }
        }
    }
}
