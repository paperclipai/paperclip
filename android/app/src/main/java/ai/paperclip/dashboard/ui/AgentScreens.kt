@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package ai.paperclip.dashboard.ui

import ai.paperclip.dashboard.data.Agent
import ai.paperclip.dashboard.data.PaperclipApi
import androidx.compose.foundation.clickable
import androidx.compose.material.icons.filled.Add
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SecondaryScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.TextButton
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.text.input.KeyboardType
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

@Composable
fun AgentsScreen(api: PaperclipApi, companyId: String, onOpen: (String) -> Unit, onHire: () -> Unit) {
    val state = rememberLoad(companyId) { api.agents(companyId) }
    Box(Modifier.fillMaxSize()) {
    LoadedContent(state) { agents ->
        val visible = agents.filter { it.status != "terminated" }.sortedWith(compareBy({ agentOrder(it.status) }, { it.name }))
        if (visible.isEmpty()) {
            LazyColumn(Modifier.fillMaxSize()) { item { EmptyState("No agents") } }
        } else {
            LazyColumn(contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 88.dp)) {
                items(visible, key = { it.id }) { a ->
                    Column(
                        Modifier.fillMaxWidth().clickable { onOpen(a.id) }.padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(a.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                            StatusPill(a.status)
                        }
                        Text(
                            listOfNotNull(a.title ?: humanize(a.role), a.adapterType.ifBlank { null }, a.lastHeartbeatAt?.let { "seen " + relativeTime(it) })
                                .joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    HorizontalDivider()
                }
            }
        }
    }
        androidx.compose.material3.ExtendedFloatingActionButton(
            onClick = onHire,
            icon = { androidx.compose.material3.Icon(androidx.compose.material.icons.Icons.Default.Add, null) },
            text = { Text("Hire agent") },
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        )
    }
}

private fun agentOrder(status: String) = when (status) {
    "error" -> 0
    "running" -> 1
    "active" -> 2
    "idle" -> 3
    "pending_approval" -> 4
    "paused" -> 5
    else -> 6
}

private val AGENT_TABS = listOf("Overview", "Runs", "Configuration", "Instructions", "Skills", "Settings", "Runtime")

@Composable
fun AgentDetailScreen(
    api: PaperclipApi,
    companyId: String,
    agentId: String,
    agentsById: Map<String, Agent>,
    onChanged: () -> Unit,
    onOpenRun: (String) -> Unit = {},
    onOpenChat: (String) -> Unit = {},
) {
    val state = rememberLoad(agentId) { api.agent(agentId, companyId) }
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var confirmTerminate by remember { mutableStateOf(false) }

    fun act(label: String, block: suspend () -> Unit) {
        if (busy) return
        busy = true
        scope.launch {
            message = runCatching { block() }.fold({ "$label requested" }, { it.message ?: "Failed" })
            busy = false
            state.reload()
            onChanged()
        }
    }

    LiveEvents(api, companyId) { ev -> if (ev.payload.s("agentId") == agentId) state.reload() }

    if (confirmTerminate) AlertDialog(
        onDismissRequest = { confirmTerminate = false },
        title = { Text("Terminate this agent?") },
        text = { Text("A terminated agent stops for good and cannot be resumed.") },
        confirmButton = {
            TextButton(onClick = { confirmTerminate = false; act("Terminate") { api.terminateAgent(agentId, companyId) } }) {
                Text("Terminate", color = MaterialTheme.colorScheme.error)
            }
        },
        dismissButton = { TextButton(onClick = { confirmTerminate = false }) { Text("Cancel") } },
    )

    LoadedContent(state) { a ->
        Column(Modifier.fillMaxSize()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(a.name, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    StatusPill(a.status)
                    Text(a.title ?: humanize(a.role), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                a.errorReason?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                a.pauseReason?.let { Text("Paused: ${humanize(it)}", color = statusColor("paused")) }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (a.status == "pending_approval") {
                        Button(enabled = !busy, onClick = { act("Approve") { api.approveAgent(a.id, companyId) } }) { Text("Approve") }
                    }
                    Button(enabled = !busy && a.status !in setOf("paused", "terminated", "pending_approval"), onClick = {
                        act("Heartbeat") { api.invokeAgent(a.id, companyId) }
                    }) { Text("Run now") }
                    if (a.status == "paused") {
                        OutlinedButton(enabled = !busy, onClick = { act("Resume") { api.resumeAgent(a.id, companyId) } }) { Text("Resume") }
                    } else if (a.status != "terminated") {
                        OutlinedButton(enabled = !busy, onClick = { act("Pause") { api.pauseAgent(a.id, companyId) } }) { Text("Pause") }
                    }
                    if (a.status == "error" || a.errorReason != null) {
                        OutlinedButton(enabled = !busy, onClick = { act("Clear error") { api.clearAgentError(a.id, companyId) } }) { Text("Clear error") }
                    }
                    OutlinedButton(enabled = !busy, onClick = {
                        busy = true
                        scope.launch {
                            val r = runCatching { api.openChat(companyId, a.urlKey ?: a.id) }
                            busy = false
                            r.onSuccess { onOpenChat(it.id) }.onFailure { message = it.message }
                        }
                    }) { Text("Chat") }
                    if (a.status != "terminated") {
                        TextButton(enabled = !busy, onClick = { confirmTerminate = true }) { Text("Terminate", color = MaterialTheme.colorScheme.error) }
                    }
                }
                message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            }
            SecondaryScrollableTabRow(selectedTabIndex = tab, edgePadding = 0.dp) {
                AGENT_TABS.forEachIndexed { i, t -> Tab(selected = tab == i, onClick = { tab = i }, text = { Text(t) }) }
            }
            Box(Modifier.weight(1f)) {
                when (tab) {
                    0 -> AgentOverview(a, agentsById)
                    1 -> RunsScreen(api, companyId, agentsById, agentId = a.id) { onOpenRun(it.id) }
                    2 -> AgentConfigTab(api, companyId, a) { state.reload(); onChanged() }
                    3 -> AgentInstructionsTab(api, companyId, a.id)
                    4 -> AgentSkillsTab(api, companyId, a.id)
                    5 -> AgentSettings(api, companyId, a, agentsById) { state.reload(); onChanged() }
                    6 -> AgentRuntime(api, companyId, a.id)
                }
            }
        }
    }
}

@Composable
private fun AgentOverview(a: Agent, agentsById: Map<String, Agent>) {
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            OutlinedCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Budget this month", style = MaterialTheme.typography.titleSmall)
                    if (a.budgetMonthlyCents > 0) {
                        LinearProgressIndicator(
                            progress = { (a.spentMonthlyCents.toFloat() / a.budgetMonthlyCents).coerceIn(0f, 1f) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Text("${money(a.spentMonthlyCents)} of ${money(a.budgetMonthlyCents)}")
                    } else {
                        Text("${money(a.spentMonthlyCents)} spent · no budget cap")
                    }
                }
            }
        }
        item {
            OutlinedCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Detail("Adapter", a.adapterType)
                    Detail("Reports to", a.reportsTo?.let { agentsById[it]?.name ?: it } ?: "Board")
                    Detail("Last heartbeat", a.lastHeartbeatAt?.let(::relativeTime) ?: "Never")
                    a.capabilities?.takeIf { it.isNotBlank() }?.let { Detail("Capabilities", it) }
                }
            }
        }
    }
}

/** Edits the fields the web Configuration tab exposes that need no adapter-specific form. */
@Composable
private fun AgentSettings(api: PaperclipApi, companyId: String, a: Agent, agentsById: Map<String, Agent>, onSaved: () -> Unit) {
    val scope = rememberCoroutineScope()
    var name by rememberSaveable(a.id) { mutableStateOf(a.name) }
    var title by rememberSaveable(a.id) { mutableStateOf(a.title.orEmpty()) }
    var capabilities by rememberSaveable(a.id) { mutableStateOf(a.capabilities.orEmpty()) }
    var budget by rememberSaveable(a.id) { mutableStateOf(if (a.budgetMonthlyCents > 0) "%.2f".format(a.budgetMonthlyCents / 100.0) else "") }
    var reportsTo by rememberSaveable(a.id) { mutableStateOf(a.reportsTo) }
    var saving by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<String?>(null) }
    var pickManager by remember { mutableStateOf(false) }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth()) }
        item { OutlinedTextField(title, { title = it }, label = { Text("Title") }, singleLine = true, modifier = Modifier.fillMaxWidth()) }
        item { OutlinedTextField(capabilities, { capabilities = it }, label = { Text("Capabilities") }, minLines = 3, modifier = Modifier.fillMaxWidth()) }
        item {
            OutlinedTextField(
                budget, { budget = it.filter { c -> c.isDigit() || c == '.' } },
                label = { Text("Monthly budget (USD, blank = no cap)") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            Box {
                OutlinedButton(onClick = { pickManager = true }) { Text("Reports to: " + (reportsTo?.let { agentsById[it]?.name ?: it } ?: "Board")) }
                DropdownMenu(expanded = pickManager, onDismissRequest = { pickManager = false }) {
                    DropdownMenuItem(text = { Text("Board") }, onClick = { reportsTo = null; pickManager = false })
                    agentsById.values.filter { it.id != a.id && it.status != "terminated" }.sortedBy { it.name }.forEach { m ->
                        DropdownMenuItem(text = { Text(m.name) }, onClick = { reportsTo = m.id; pickManager = false })
                    }
                }
            }
        }
        item {
            Button(enabled = !saving && name.isNotBlank(), onClick = {
                saving = true
                scope.launch {
                    result = runCatching {
                        api.updateAgent(a.id, companyId, buildJsonObject {
                            put("name", name.trim())
                            put("title", title.trim().ifBlank { null })
                            put("capabilities", capabilities.trim().ifBlank { null })
                            put("budgetMonthlyCents", budget.toDoubleOrNull()?.let { (it * 100).toLong() } ?: 0L)
                            put("reportsTo", reportsTo)
                        })
                    }.fold({ "Saved" }, { it.message ?: "Failed" })
                    saving = false
                    onSaved()
                }
            }) { Text(if (saving) "Saving…" else "Save") }
            result?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

@Composable
private fun AgentRuntime(api: PaperclipApi, companyId: String, agentId: String) {
    val state = rememberLoad(agentId, "runtime") { api.agentRuntimeState(agentId, companyId) }
    LoadedContent(state) { JsonDetailScreen(it) }
}

@Composable
fun Detail(label: String, value: String) {
    Column {
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}
