package ai.paperclip.dashboard.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.TextButton
import ai.paperclip.dashboard.data.Agent
import ai.paperclip.dashboard.data.Decision
import ai.paperclip.dashboard.data.Goal
import ai.paperclip.dashboard.data.PaperclipApi
import ai.paperclip.dashboard.data.SearchResult
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Standard two-line list row used by the side-menu sections. */
@Composable
fun ListRow(title: String, subtitle: String?, status: String? = null, indent: Int = 0, onClick: (() -> Unit)? = null) {
    Column(
        Modifier.fillMaxWidth()
            .let { if (onClick != null) it.clickable(onClick = onClick) else it }
            .padding(start = 16.dp + (indent * 16).dp, end = 16.dp, top = 12.dp, bottom = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                title.ifBlank { "Untitled" },
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (!status.isNullOrBlank()) StatusPill(status)
        }
        if (!subtitle.isNullOrBlank()) {
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
    HorizontalDivider()
}

@Composable
fun StatusChips(options: List<String?>, selected: String?, onSelect: (String?) -> Unit) {
    Row(
        Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        options.forEach { s ->
            FilterChip(selected = selected == s, onClick = { onSelect(s) }, label = { Text(s?.let(::humanize) ?: "All") })
        }
    }
}

// --- Search ---

@Composable
fun SearchScreen(api: PaperclipApi, companyId: String, onOpen: (SearchResult) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var debounced by remember { mutableStateOf(query) }
    LaunchedEffect(query) {
        delay(350)
        debounced = query.trim()
    }
    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            placeholder = { Text("Search tasks, agents, projects…") },
            leadingIcon = { Icon(Icons.Default.Search, null) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        )
        if (debounced.length < 2) {
            EmptyState("Type at least two characters to search.")
        } else {
            val state = rememberLoad(companyId, debounced) { api.search(companyId, debounced) }
            LoadedContent(state) { res ->
                LazyColumn(Modifier.fillMaxSize()) {
                    if (res.results.isEmpty()) item { EmptyState("No results for “$debounced”") }
                    items(res.results, key = { it.type + it.id }) { r ->
                        ListRow(
                            r.title,
                            listOfNotNull(humanize(r.type), r.sourceLabel, r.snippet).joinToString(" · "),
                            onClick = { onOpen(r) },
                        )
                    }
                }
            }
        }
    }
}

// --- Projects ---

@Composable
fun ProjectsScreen(api: PaperclipApi, companyId: String, agentsById: Map<String, Agent>, onOpen: (String) -> Unit, onNew: () -> Unit) {
    val state = rememberLoad(companyId) { api.projects(companyId) }
    var showArchived by rememberSaveable { mutableStateOf(false) }
    Box(Modifier.fillMaxSize()) {
    LoadedContent(state) { projects ->
        val visible = projects.filter { showArchived || it.archivedAt == null }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 88.dp)) {
            if (projects.any { it.archivedAt != null }) item {
                StatusChips(listOf(null, "archived"), if (showArchived) "archived" else null) { showArchived = it != null }
            }
            if (visible.isEmpty()) item { EmptyState("No projects") }
            items(visible, key = { it.id }) { p ->
                ListRow(
                    p.name,
                    listOfNotNull(
                        p.leadAgentId?.let { agentsById[it]?.name }?.let { "Lead: $it" },
                        p.targetDate?.take(10)?.let { "Target $it" },
                        p.description?.lineSequence()?.firstOrNull(),
                    ).joinToString(" · "),
                    p.status,
                ) { onOpen(p.id) }
            }
        }
    }
        ExtendedFloatingActionButton(
            onClick = onNew,
            icon = { Icon(Icons.Default.Add, null) },
            text = { Text("New project") },
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        )
    }
}

/** Project header plus the project's task list. */
@Composable
fun ProjectDetailScreen(
    api: PaperclipApi,
    companyId: String,
    projectId: String,
    agentsById: Map<String, Agent>,
    onOpenIssue: (String) -> Unit,
    onNewIssue: () -> Unit,
    onEdit: () -> Unit,
) {
    val state = rememberLoad(projectId) { api.project(projectId, companyId) }
    Column(Modifier.fillMaxSize()) {
        state.data?.let { p ->
            Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(p.name, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                    if (p.status.isNotBlank()) StatusPill(p.status)
                    TextButton(onClick = onEdit) { Text("Edit") }
                }
                p.description?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = MaterialTheme.typography.bodyMedium, maxLines = 4, overflow = TextOverflow.Ellipsis)
                }
            }
            HorizontalDivider()
        }
        state.error?.let { ErrorBanner(it) }
        IssuesScreen(api, companyId, null, agentsById, onOpenIssue, onNewIssue, filter = "projectId=$projectId")
    }
}

// --- Goals ---

val GOAL_STATUSES = listOf("planned", "active", "achieved", "cancelled")

@Composable
fun GoalsScreen(api: PaperclipApi, companyId: String, onOpen: (String) -> Unit, onNew: () -> Unit) {
    val state = rememberLoad(companyId) { api.goals(companyId) }
    Box(Modifier.fillMaxSize()) {
    LoadedContent(state) { goals ->
        // Flatten the parent/child tree depth-first so sub-goals sit under their parent.
        val byParent = goals.groupBy { it.parentId?.takeIf { p -> goals.any { g -> g.id == p } } }
        val rows = mutableListOf<Pair<Goal, Int>>()
        fun walk(parent: String?, depth: Int) {
            byParent[parent].orEmpty().sortedBy { it.title }.forEach { g ->
                rows += g to depth
                walk(g.id, depth + 1)
            }
        }
        walk(null, 0)
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 88.dp)) {
            if (rows.isEmpty()) item { EmptyState("No goals") }
            items(rows, key = { it.first.id }) { (g, depth) ->
                ListRow(g.title, humanize(g.level.ifBlank { "goal" }), g.status, indent = depth.coerceAtMost(4)) { onOpen(g.id) }
            }
        }
    }
        ExtendedFloatingActionButton(
            onClick = onNew,
            icon = { Icon(Icons.Default.Add, null) },
            text = { Text("New goal") },
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        )
    }
}

@Composable
fun GoalDetailScreen(api: PaperclipApi, goalId: String, agentsById: Map<String, Agent>, onEdit: () -> Unit, onAddSubGoal: () -> Unit) {
    val state = rememberLoad(goalId) { api.goal(goalId) }
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var actionError by remember { mutableStateOf<String?>(null) }
    LoadedContent(state) { g ->
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Text(g.title, style = MaterialTheme.typography.headlineSmall)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = onEdit) { Text("Edit") }
                    OutlinedButton(onClick = onAddSubGoal) { Text("Add sub-goal") }
                }
                Detail("Level", humanize(g.level))
                Detail("Owner", g.ownerAgentId?.let { agentsById[it]?.name } ?: "—")
                Detail("Updated", relativeTime(g.updatedAt))
            }
            g.description?.takeIf { it.isNotBlank() }?.let { item { OutlinedCard { Text(it, Modifier.padding(16.dp)) } } }
            item {
                Text("Status", style = MaterialTheme.typography.titleSmall)
                StatusChips(GOAL_STATUSES, g.status) { s ->
                    if (s == null || s == g.status || busy) return@StatusChips
                    busy = true
                    scope.launch {
                        actionError = runCatching { api.updateGoal(g.id, buildJsonObject { put("status", s) }) }.exceptionOrNull()?.message
                        busy = false
                        state.reload()
                    }
                }
                actionError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        }
    }
}

// --- Routines ---

@Composable
fun RoutinesScreen(api: PaperclipApi, companyId: String, agentsById: Map<String, Agent>, onOpen: (String) -> Unit, onNew: () -> Unit) {
    val state = rememberLoad(companyId) { api.routines(companyId) }
    var showArchived by rememberSaveable { mutableStateOf(false) }
    Box(Modifier.fillMaxSize()) {
    LoadedContent(state) { routines ->
        val visible = routines.filter { showArchived || it.status != "archived" }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 88.dp)) {
            if (routines.any { it.status == "archived" }) item {
                StatusChips(listOf(null, "archived"), if (showArchived) "archived" else null) { showArchived = it != null }
            }
            if (visible.isEmpty()) item { EmptyState("No routines") }
            items(visible, key = { it.id }) { r ->
                val next = r.triggers.filter { it.enabled }.mapNotNull { it.nextRunAt }.minOrNull()
                ListRow(
                    r.title,
                    listOfNotNull(
                        r.assigneeAgentId?.let { agentsById[it]?.name },
                        r.triggers.firstOrNull()?.let { it.label ?: it.cronExpression ?: humanize(it.kind) },
                        next?.let { "next ${it.take(16).replace('T', ' ')}" },
                        r.lastRun?.let { "last ${humanize(it.status)}" },
                    ).joinToString(" · "),
                    r.status,
                ) { onOpen(r.id) }
            }
        }
    }
        ExtendedFloatingActionButton(
            onClick = onNew,
            icon = { Icon(Icons.Default.Add, null) },
            text = { Text("New routine") },
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        )
    }
}

@Composable
fun RoutineDetailScreen(api: PaperclipApi, routineId: String, agentsById: Map<String, Agent>, onEdit: () -> Unit, onOpenIssue: (String) -> Unit) {
    val state = rememberLoad(routineId) {
        Triple(api.routine(routineId), runCatching { api.routineRuns(routineId) }.getOrDefault(emptyList()),
            (api.getJson("/routines/$routineId") as kotlinx.serialization.json.JsonObject).arr("triggers"))
    }
    var addingTrigger by remember { mutableStateOf(false) }
    var createdSecret by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    fun act(label: String, block: suspend () -> Unit) {
        busy = true
        scope.launch {
            message = runCatching { block() }.fold({ label }, { it.message })
            busy = false
            state.reload()
        }
    }
    if (addingTrigger) AddTriggerDialog(api, routineId, onDismiss = { addingTrigger = false }) { res ->
        addingTrigger = false
        createdSecret = res?.obj("secretMaterial")?.let { m -> "Webhook URL: ${m.str("webhookUrl")}\nSecret (shown once): ${m.str("webhookSecret")}" }
        state.reload()
    }
    LoadedContent(state) { (r, runs, triggers) ->
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(r.title, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
                    StatusPill(r.status)
                }
                Detail("Assignee", r.assigneeAgentId?.let { agentsById[it]?.name } ?: "—")
                Detail("Updated", relativeTime(r.updatedAt))
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(enabled = !busy, onClick = { act("Run started") { api.runRoutine(r.id) } }) { Text("Run now") }
                    OutlinedButton(onClick = onEdit) { Text("Edit") }
                    if (r.status == "paused") {
                        OutlinedButton(enabled = !busy, onClick = { act("Resumed") { api.setRoutineStatus(r.id, "active") } }) { Text("Resume") }
                    } else {
                        OutlinedButton(enabled = !busy, onClick = { act("Paused") { api.setRoutineStatus(r.id, "paused") } }) { Text("Pause") }
                    }
                }
                message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            }
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Triggers", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                    TextButton(onClick = { addingTrigger = true }) { Text("Add trigger") }
                }
                createdSecret?.let {
                    androidx.compose.foundation.text.selection.SelectionContainer {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                    }
                }
            }
            if (triggers.isEmpty()) item { Text("No triggers. The routine only runs when you start it.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            items(triggers, key = { "trigger:" + (it.str("id") ?: it.toString()) }) { t -> TriggerCard(api, t) { state.reload() } }
            r.description?.takeIf { it.isNotBlank() }?.let { d ->
                item {
                    var expanded by rememberSaveable { mutableStateOf(false) }
                    Text("Instructions", style = MaterialTheme.typography.titleMedium)
                    OutlinedCard(Modifier.fillMaxWidth().clickable { expanded = !expanded }) {
                        Column(Modifier.padding(16.dp)) {
                            if (expanded) Markdown(d)
                            else Text(d, maxLines = 6, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall)
                            Text(if (expanded) "Show less" else "Show more", color = MaterialTheme.colorScheme.primary,
                                style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 8.dp))
                        }
                    }
                }
            }
            item { Text("Recent runs", style = MaterialTheme.typography.titleMedium) }
            if (runs.isEmpty()) item { Text("No runs yet", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            items(runs, key = { it.id }) { run ->
                Row(
                    Modifier.fillMaxWidth().clickable(enabled = run.linkedIssue != null) { run.linkedIssue?.id?.let(onOpenIssue) },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(relativeTime(run.triggeredAt ?: run.createdAt))
                        run.linkedIssue?.let { i ->
                            Text(listOfNotNull(i.identifier, i.title).joinToString(" "), style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    StatusPill(run.status)
                }
            }
        }
    }
}

// --- Decisions ---

@Composable
fun DecisionsScreen(api: PaperclipApi, companyId: String, agentsById: Map<String, Agent>, onOpen: (String) -> Unit) {
    var status by rememberSaveable { mutableStateOf<String?>("open") }
    val state = rememberLoad(companyId, status) { api.decisions(companyId, status) }
    Column(Modifier.fillMaxSize()) {
        StatusChips(listOf("open", "decided", "expired", "cancelled", null), status) { status = it }
        LoadedContent(state) { decisions ->
            LazyColumn(Modifier.fillMaxSize()) {
                if (decisions.isEmpty()) item { EmptyState("No decisions") }
                items(decisions, key = { it.id }) { d ->
                    ListRow(
                        d.title,
                        listOfNotNull(d.originAgentId?.let { agentsById[it]?.name }, relativeTime(d.createdAt)).joinToString(" · "),
                        d.status,
                    ) { onOpen(d.id) }
                }
            }
        }
    }
}

@Composable
fun DecisionDetailScreen(api: PaperclipApi, companyId: String, decisionId: String, agentsById: Map<String, Agent>, onOpenIssue: (String) -> Unit) {
    // The list payload carries everything the card needs; reuse it rather than the outcome endpoint.
    val state = rememberLoad(decisionId) {
        api.decisions(companyId, null).firstOrNull { it.id == decisionId } ?: error("Decision not found")
    }
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var actionError by remember { mutableStateOf<String?>(null) }
    fun act(block: suspend () -> Unit) {
        busy = true
        scope.launch {
            actionError = runCatching { block() }.exceptionOrNull()?.message
            busy = false
            state.reload()
        }
    }
    LoadedContent(state) { d: Decision ->
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(d.title, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
                    StatusPill(d.status)
                }
                Detail("From", d.originAgentId?.let { agentsById[it]?.name } ?: "—")
                Detail("Created", relativeTime(d.createdAt))
                d.originIssueId?.let { id ->
                    OutlinedButton(onClick = { onOpenIssue(id) }) { Text("Open source task") }
                }
            }
            if (d.body.isNotBlank()) item { OutlinedCard { Text(d.body, Modifier.padding(16.dp)) } }
            item { Text("Options", style = MaterialTheme.typography.titleMedium) }
            items(d.options, key = { it.id }) { o ->
                val chosen = d.chosenOptionId == o.id
                OutlinedCard(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text((o.label ?: o.title ?: o.id) + if (chosen) "  ✓" else "", fontWeight = FontWeight.Medium)
                        o.description?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                        if (d.status == "open") {
                            Button(enabled = !busy, onClick = { act { api.decide(d.id, o.id) } }) { Text("Choose") }
                        }
                    }
                }
            }
            if (d.status == "open") {
                item { OutlinedButton(enabled = !busy, onClick = { act { api.dismissDecision(d.id) } }) { Text("Dismiss") } }
            }
            actionError?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
        }
    }
}
