package ai.paperclip.dashboard.ui

import ai.paperclip.dashboard.data.OrgNode
import ai.paperclip.dashboard.data.PaperclipApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import java.util.Locale

// --- Costs ---

@Composable
fun CostsScreen(api: PaperclipApi, companyId: String, onOpenAgent: (String) -> Unit) {
    val state = rememberLoad(companyId) {
        coroutineScope {
            val summary = async { api.costSummary(companyId) }
            val byAgent = async { runCatching { api.costsByAgent(companyId) }.getOrDefault(emptyList()) }
            val byProject = async { runCatching { api.costsByProject(companyId) }.getOrDefault(emptyList()) }
            Triple(summary.await(), byAgent.await(), byProject.await())
        }
    }
    LoadedContent(state) { (s, byAgent, byProject) ->
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                OutlinedCard(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("This month", style = MaterialTheme.typography.labelLarge)
                        Text(money(s.spendCents), style = MaterialTheme.typography.headlineMedium)
                        if (s.budgetCents > 0) {
                            LinearProgressIndicator(
                                progress = { (s.spendCents.toFloat() / s.budgetCents).coerceIn(0f, 1f) },
                                modifier = Modifier.fillMaxWidth(),
                            )
                            Text(
                                "${String.format(Locale.US, "%.0f", s.utilizationPercent)}% of ${money(s.budgetCents)} budget",
                                style = MaterialTheme.typography.bodySmall,
                            )
                        } else {
                            Text("No monthly budget set", style = MaterialTheme.typography.bodySmall)
                        }
                        Text(
                            listOfNotNull(
                                "${s.eventCount} cost events",
                                s.pendingRunCount.takeIf { it > 0 }?.let { "$it runs pending accounting" },
                                if (s.pricingComplete) null else "pricing incomplete",
                            ).joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            if (byAgent.isNotEmpty()) {
                item { Text("By agent", style = MaterialTheme.typography.titleMedium) }
                val max = byAgent.maxOf { it.costCents }.coerceAtLeast(1)
                items(byAgent.sortedByDescending { it.costCents }, key = { "agent:${it.agentId}" }) { a ->
                    CostBar(a.agentName ?: "Unattributed", a.costCents, max, "${tokens(a.inputTokens)} in · ${tokens(a.outputTokens)} out") {
                        a.agentId?.let(onOpenAgent)
                    }
                }
            }
            if (byProject.isNotEmpty()) {
                item { Text("By project", style = MaterialTheme.typography.titleMedium) }
                val max = byProject.maxOf { it.costCents }.coerceAtLeast(1)
                items(byProject.sortedByDescending { it.costCents }, key = { "project:${it.projectId}" }) { p ->
                    CostBar(p.projectName ?: "No project", p.costCents, max, "${tokens(p.inputTokens)} in · ${tokens(p.outputTokens)} out", null)
                }
            }
        }
    }
}

@Composable
private fun CostBar(label: String, cents: Long, max: Long, detail: String, onClick: (() -> Unit)?) {
    Column(
        Modifier.fillMaxWidth().let { if (onClick != null) it.clickable(onClick = onClick) else it },
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(label, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
            Text(money(cents))
        }
        LinearProgressIndicator(progress = { cents.toFloat() / max }, modifier = Modifier.fillMaxWidth())
        Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

private fun tokens(n: Long): String = when {
    n >= 1_000_000 -> String.format(Locale.US, "%.1fM", n / 1_000_000.0)
    n >= 1_000 -> String.format(Locale.US, "%.1fk", n / 1_000.0)
    else -> n.toString()
}

// --- Org chart ---

@Composable
fun OrgChartScreen(api: PaperclipApi, companyId: String, onOpenAgent: (String) -> Unit) {
    val state = rememberLoad(companyId) { api.org(companyId) }
    LoadedContent(state) { roots ->
        val rows = mutableListOf<Pair<OrgNode, Int>>()
        fun walk(n: OrgNode, depth: Int) {
            rows += n to depth
            n.reports.forEach { walk(it, depth + 1) }
        }
        roots.forEach { walk(it, 0) }
        LazyColumn(Modifier.fillMaxSize()) {
            if (rows.isEmpty()) item { EmptyState("No agents in the org chart") }
            items(rows, key = { it.first.id }) { (n, depth) ->
                ListRow(
                    (if (depth > 0) "└ " else "") + n.name,
                    humanize(n.role) + if (n.reports.isNotEmpty()) " · ${n.reports.size} direct reports" else "",
                    n.status,
                    indent = depth.coerceAtMost(6),
                ) { onOpenAgent(n.id) }
            }
        }
    }
}

// --- Company settings ---

@Composable
fun SettingsScreen(api: PaperclipApi, companyId: String, onSaved: () -> Unit) {
    val state = rememberLoad(companyId) { api.company(companyId) }
    LoadedContent(state) { c ->
        var name by remember(c) { mutableStateOf(c.name) }
        var description by remember(c) { mutableStateOf(c.description.orEmpty()) }
        var budget by remember(c) { mutableStateOf(if (c.budgetMonthlyCents > 0) (c.budgetMonthlyCents / 100.0).toString() else "") }
        var requireApproval by remember(c) { mutableStateOf(c.requireBoardApprovalForNewAgents) }
        var busy by remember { mutableStateOf(false) }
        var message by remember { mutableStateOf<String?>(null) }
        val scope = rememberCoroutineScope()
        val budgetCents = budget.trim().takeIf { it.isNotEmpty() }?.toDoubleOrNull()?.let { (it * 100).toLong() }
        val budgetValid = budget.isBlank() || (budgetCents != null && budgetCents >= 0)

        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { Text("Company", style = MaterialTheme.typography.titleMedium) }
            item { OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth()) }
            item {
                OutlinedTextField(description, { description = it }, label = { Text("Description") }, minLines = 3, modifier = Modifier.fillMaxWidth())
            }
            item {
                OutlinedTextField(
                    budget, { budget = it },
                    label = { Text("Monthly budget (USD)") },
                    placeholder = { Text("No limit") },
                    isError = !budgetValid,
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Require board approval for new agents")
                        Text("Hires wait in Approvals until a board member decides.", style = MaterialTheme.typography.bodySmall)
                    }
                    Switch(requireApproval, { requireApproval = it })
                }
            }
            item { Detail("Issue prefix", c.issuePrefix.ifBlank { "—" }) }
            item { Detail("Status", humanize(c.status)) }
            item {
                Button(
                    enabled = !busy && name.isNotBlank() && budgetValid,
                    onClick = {
                        busy = true
                        scope.launch {
                            message = runCatching {
                                api.updateCompany(companyId, buildJsonObject {
                                    put("name", name.trim())
                                    put("description", description.trim())
                                    put("budgetMonthlyCents", budgetCents ?: 0L)
                                    put("requireBoardApprovalForNewAgents", requireApproval)
                                })
                            }.fold({ onSaved(); "Saved" }, { it.message })
                            busy = false
                            state.reload()
                        }
                    },
                ) { Text("Save") }
                message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
}

// --- Generic JSON sections (artifacts, workspaces, skills, connectors, members) ---

/** Pulls the list out of either a bare array or a `{ items | results | data | <first array> }` wrapper. */
fun JsonElement.asItems(): List<JsonObject> {
    val array = when (this) {
        is JsonArray -> this
        is JsonObject -> listOf("items", "results", "data", "members", "connections", "workspaces", "artifacts", "skills")
            .firstNotNullOfOrNull { this[it] as? JsonArray }
            ?: values.firstOrNull { it is JsonArray } as? JsonArray
        else -> null
    }
    return array?.filterIsInstance<JsonObject>().orEmpty()
}

fun JsonObject.str(vararg keys: String): String? =
    keys.firstNotNullOfOrNull { (this[it] as? JsonPrimitive)?.contentOrNull?.takeIf { s -> s.isNotBlank() } }

fun JsonObject.titleText(): String =
    str("name", "title", "label", "displayName", "identifier", "slug", "key", "email")
        ?: (this["user"] as? JsonObject)?.str("name", "email")
        ?: str("id") ?: "Untitled"

private fun JsonObject.subtitleText(): String = listOfNotNull(
    str("kind", "type", "adapterType", "provider", "category", "role", "membershipRole"),
    str("description", "summary", "branchName", "path", "mimeType")?.lineSequence()?.firstOrNull(),
    str("updatedAt", "createdAt")?.let(::relativeTime),
).joinToString(" · ")

@Composable
fun JsonListScreen(api: PaperclipApi, path: String, emptyText: String, onOpen: (JsonObject) -> Unit) {
    val state = rememberLoad(path) { api.getJson(path).asItems() }
    LoadedContent(state) { items ->
        LazyColumn(Modifier.fillMaxSize()) {
            if (items.isEmpty()) item { EmptyState(emptyText) }
            items(items) { o -> ListRow(o.titleText(), o.subtitleText(), o.str("status", "state")) { onOpen(o) } }
        }
    }
}

/** Read-only field view for an item from a [JsonListScreen]. */
@Composable
fun JsonDetailScreen(obj: JsonObject?) {
    if (obj == null) {
        EmptyState("Nothing selected")
        return
    }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { Text(obj.titleText(), style = MaterialTheme.typography.headlineSmall) }
        items(obj.entries.filter { it.value !is JsonNull }.toList(), key = { it.key }) { (k, v) ->
            Column {
                Text(humanize(k), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                when (v) {
                    is JsonPrimitive -> Text(v.contentOrNull.orEmpty(), style = MaterialTheme.typography.bodyMedium)
                    else -> Text(
                        v.toString().let { if (it.length > 600) it.take(600) + "…" else it },
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }
        }
    }
}
