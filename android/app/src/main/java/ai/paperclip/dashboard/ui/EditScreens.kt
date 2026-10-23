package ai.paperclip.dashboard.ui

import ai.paperclip.dashboard.data.Agent
import ai.paperclip.dashboard.data.ISSUE_PRIORITIES
import ai.paperclip.dashboard.data.PaperclipApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.TimeZone

val PROJECT_STATUSES = listOf("backlog", "planned", "in_progress", "completed", "cancelled")
val GOAL_LEVELS = listOf("company", "team", "agent", "task")
val ROUTINE_STATUSES = listOf("active", "paused", "archived")
val ROUTINE_CONCURRENCY = listOf("coalesce_if_active", "always_enqueue", "skip_if_active")
val ROUTINE_CATCH_UP = listOf("skip_missed", "enqueue_missed_with_cap")

/** Dropdown over id → label pairs, with an optional "None" row. */
@Composable
fun PickerButton(label: String, selected: String?, options: List<Pair<String, String>>, noneLabel: String? = "None", onPick: (String?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { open = true }) {
            Text("$label: " + (options.firstOrNull { it.first == selected }?.second ?: selected?.let { "…" } ?: noneLabel ?: "—"))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            if (noneLabel != null) DropdownMenuItem(text = { Text(noneLabel) }, onClick = { open = false; onPick(null) })
            options.forEach { (id, name) -> DropdownMenuItem(text = { Text(name) }, onClick = { open = false; onPick(id) }) }
        }
    }
}

private fun agentOptions(agentsById: Map<String, Agent>) =
    agentsById.values.filter { it.status != "terminated" }.sortedBy { it.name }.map { it.id to it.name }

private fun JsonObject.nullableStr(key: String): JsonPrimitive? = str(key)?.let(::JsonPrimitive)

/**
 * Shared shell for create/edit forms: loads the existing record (when editing), keeps
 * the form in [JsonObject] state, and exposes save/delete with errors shown inline.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun EditForm(
    loadKey: String?,
    load: suspend () -> JsonObject,
    deleteLabel: String?,
    onDelete: (suspend () -> Unit)?,
    onSave: suspend (JsonObject) -> String,
    onSaved: (String) -> Unit,
    content: @Composable (JsonObject, (String, JsonPrimitive?) -> Unit) -> Unit,
) {
    val state = rememberLoad(loadKey ?: "new") { if (loadKey == null) JsonObject(emptyMap()) else load() }
    val runner = rememberActionRunner()
    var confirmDelete by remember { mutableStateOf(false) }
    LoadedContent(state) { initial ->
        var form by remember(initial) { mutableStateOf(initial) }
        val set: (String, JsonPrimitive?) -> Unit = { k, v -> form = JsonObject(form.toMutableMap().apply { put(k, v ?: JsonNull) }) }
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            content(form, set)
            ActionMessages(runner)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(enabled = !runner.busy, onClick = { runner.run { onSaved(onSave(form)) } }) {
                    Text(if (loadKey == null) "Create" else "Save")
                }
                if (onDelete != null && deleteLabel != null) TextButton(enabled = !runner.busy, onClick = { confirmDelete = true }) {
                    Text(deleteLabel, color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }
    if (confirmDelete && onDelete != null) AlertDialog(
        onDismissRequest = { confirmDelete = false },
        title = { Text("$deleteLabel?") },
        text = { Text("This cannot be undone.") },
        confirmButton = {
            TextButton(onClick = { confirmDelete = false; runner.run { onDelete() } }) {
                Text(deleteLabel ?: "Delete", color = MaterialTheme.colorScheme.error)
            }
        },
        dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
    )
}

@Composable
private fun TextInput(form: JsonObject, key: String, label: String, set: (String, JsonPrimitive?) -> Unit, lines: Int = 1, placeholder: String? = null) {
    OutlinedTextField(
        form.str(key).orEmpty(), { set(key, if (it.isEmpty() && key != "title" && key != "name") null else JsonPrimitive(it)) },
        label = { Text(label) }, singleLine = lines == 1, minLines = lines, modifier = Modifier.fillMaxWidth(),
        placeholder = placeholder?.let { p -> { Text(p) } },
    )
}

// --- Projects ---

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ProjectEditScreen(api: PaperclipApi, companyId: String, projectId: String?, agentsById: Map<String, Agent>, onSaved: (String) -> Unit, onDeleted: () -> Unit) {
    val goals = rememberLoad(companyId) { api.goals(companyId) }.data.orEmpty()
    EditForm(
        loadKey = projectId,
        load = { api.getJson("/projects/$projectId?companyId=$companyId") as JsonObject },
        deleteLabel = "Delete project",
        onDelete = projectId?.let { id -> { api.sendJson("DELETE", "/projects/$id?companyId=$companyId"); onDeleted() } },
        onSave = { f ->
            val body = buildJsonObject {
                put("name", f.str("name")?.trim().orEmpty())
                put("description", f.nullableStr("description") ?: JsonNull)
                put("status", f.str("status") ?: "backlog")
                put("leadAgentId", f.nullableStr("leadAgentId") ?: JsonNull)
                put("targetDate", f.nullableStr("targetDate") ?: JsonNull)
                put("color", f.nullableStr("color") ?: JsonNull)
                f.str("goalId")?.let { put("goalIds", kotlinx.serialization.json.JsonArray(listOf(JsonPrimitive(it)))) }
            }
            val res = if (projectId == null) api.sendJson("POST", "/companies/$companyId/projects", body)
            else api.sendJson("PATCH", "/projects/$projectId?companyId=$companyId", body)
            (res as? JsonObject)?.str("id") ?: projectId!!
        },
        onSaved = onSaved,
    ) { f, set ->
        TextInput(f, "name", "Name", set)
        TextInput(f, "description", "Description (markdown)", set, lines = 4)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ChoiceButton("Status", f.str("status") ?: "backlog", PROJECT_STATUSES) { set("status", JsonPrimitive(it)) }
            PickerButton("Lead", f.str("leadAgentId"), agentOptions(agentsById)) { set("leadAgentId", it?.let(::JsonPrimitive)) }
            val currentGoal = f.str("goalId") ?: f.strings("goalIds").firstOrNull()
            PickerButton("Goal", currentGoal, goals.map { it.id to it.title }) { set("goalId", it?.let(::JsonPrimitive)) }
        }
        OutlinedTextField(f.str("targetDate")?.take(10).orEmpty(), { set("targetDate", it.takeIf(String::isNotBlank)?.let(::JsonPrimitive)) },
            label = { Text("Target date") }, placeholder = { Text("YYYY-MM-DD") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        TextInput(f, "color", "Color", set, placeholder = "#6366f1")
        if (projectId != null) {
            val archived = f.str("archivedAt") != null
            OutlinedButton(onClick = {
                set("archivedAt", if (archived) null else JsonPrimitive(java.time.Instant.now().toString()))
            }) { Text(if (archived) "Unarchive on save" else "Archive on save") }
        }
    }
}

// --- Goals ---

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun GoalEditScreen(api: PaperclipApi, companyId: String, goalId: String?, parentId: String?, agentsById: Map<String, Agent>, onSaved: (String) -> Unit, onDeleted: () -> Unit) {
    val goals = rememberLoad(companyId) { api.goals(companyId) }.data.orEmpty()
    EditForm(
        loadKey = goalId,
        load = { api.getJson("/goals/$goalId") as JsonObject },
        deleteLabel = "Delete goal",
        onDelete = goalId?.let { id -> { api.sendJson("DELETE", "/goals/$id"); onDeleted() } },
        onSave = { f ->
            val body = buildJsonObject {
                put("title", f.str("title")?.trim().orEmpty())
                put("description", f.nullableStr("description") ?: JsonNull)
                put("level", f.str("level") ?: "task")
                put("status", f.str("status") ?: "planned")
                put("parentId", f.nullableStr("parentId") ?: parentId?.takeIf { goalId == null }?.let(::JsonPrimitive) ?: JsonNull)
                put("ownerAgentId", f.nullableStr("ownerAgentId") ?: JsonNull)
            }
            val res = if (goalId == null) api.sendJson("POST", "/companies/$companyId/goals", body)
            else api.sendJson("PATCH", "/goals/$goalId", body)
            (res as? JsonObject)?.str("id") ?: goalId!!
        },
        onSaved = onSaved,
    ) { f, set ->
        TextInput(f, "title", "Title", set)
        TextInput(f, "description", "Description", set, lines = 4)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ChoiceButton("Level", f.str("level") ?: "task", GOAL_LEVELS) { set("level", JsonPrimitive(it)) }
            ChoiceButton("Status", f.str("status") ?: "planned", GOAL_STATUSES) { set("status", JsonPrimitive(it)) }
            PickerButton("Owner", f.str("ownerAgentId"), agentOptions(agentsById)) { set("ownerAgentId", it?.let(::JsonPrimitive)) }
            PickerButton("Parent", f.str("parentId") ?: parentId.takeIf { goalId == null },
                goals.filter { it.id != goalId }.map { it.id to it.title }) { set("parentId", it?.let(::JsonPrimitive)) }
        }
    }
}

// --- Routines ---

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RoutineEditScreen(api: PaperclipApi, companyId: String, routineId: String?, agentsById: Map<String, Agent>, onSaved: (String) -> Unit) {
    val projects = rememberLoad(companyId) { api.projects(companyId) }.data.orEmpty()
    EditForm(
        loadKey = routineId,
        load = { api.getJson("/routines/$routineId") as JsonObject },
        deleteLabel = null,
        onDelete = null,
        onSave = { f ->
            val body = buildJsonObject {
                put("title", f.str("title")?.trim().orEmpty())
                put("description", f.nullableStr("description") ?: JsonNull)
                put("assigneeAgentId", f.nullableStr("assigneeAgentId") ?: JsonNull)
                put("projectId", f.nullableStr("projectId") ?: JsonNull)
                put("priority", f.str("priority") ?: "medium")
                put("status", f.str("status") ?: "active")
                put("concurrencyPolicy", f.str("concurrencyPolicy") ?: ROUTINE_CONCURRENCY[0])
                put("catchUpPolicy", f.str("catchUpPolicy") ?: ROUTINE_CATCH_UP[0])
            }
            val res = if (routineId == null) api.sendJson("POST", "/companies/$companyId/routines", body)
            else api.sendJson("PATCH", "/routines/$routineId", body)
            (res as? JsonObject)?.str("id") ?: routineId!!
        },
        onSaved = onSaved,
    ) { f, set ->
        TextInput(f, "title", "Title", set)
        TextInput(f, "description", "Instructions for each run (markdown)", set, lines = 5)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            PickerButton("Assignee", f.str("assigneeAgentId"), agentOptions(agentsById), noneLabel = "Unassigned") {
                set("assigneeAgentId", it?.let(::JsonPrimitive))
            }
            PickerButton("Project", f.str("projectId"), projects.filter { it.archivedAt == null }.map { it.id to it.name }) {
                set("projectId", it?.let(::JsonPrimitive))
            }
            ChoiceButton("Priority", f.str("priority") ?: "medium", ISSUE_PRIORITIES) { set("priority", JsonPrimitive(it)) }
            ChoiceButton("Status", f.str("status") ?: "active", ROUTINE_STATUSES) { set("status", JsonPrimitive(it)) }
            ChoiceButton("If already running", f.str("concurrencyPolicy") ?: ROUTINE_CONCURRENCY[0], ROUTINE_CONCURRENCY) {
                set("concurrencyPolicy", JsonPrimitive(it))
            }
            ChoiceButton("Missed runs", f.str("catchUpPolicy") ?: ROUTINE_CATCH_UP[0], ROUTINE_CATCH_UP) { set("catchUpPolicy", JsonPrimitive(it)) }
        }
        if (routineId == null) Text("Add a schedule, webhook or API trigger after you create the routine.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

private val TRIGGER_KINDS = listOf("schedule", "webhook", "api")

/** Dialog that creates a routine trigger. Webhook secrets are shown once in the result. */
@Composable
fun AddTriggerDialog(api: PaperclipApi, routineId: String, onDismiss: () -> Unit, onCreated: (JsonObject?) -> Unit) {
    var kind by rememberSaveable { mutableStateOf("schedule") }
    var label by rememberSaveable { mutableStateOf("") }
    var cron by rememberSaveable { mutableStateOf("0 9 * * 1-5") }
    var tz by rememberSaveable { mutableStateOf(TimeZone.getDefault().id) }
    val runner = rememberActionRunner()
    AlertDialog(
        onDismissRequest = { if (!runner.busy) onDismiss() },
        title = { Text("Add trigger") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                ChoiceButton("Kind", kind, TRIGGER_KINDS) { kind = it }
                OutlinedTextField(label, { label = it }, label = { Text("Label (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                if (kind == "schedule") {
                    OutlinedTextField(cron, { cron = it }, label = { Text("Cron expression") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(tz, { tz = it }, label = { Text("Timezone") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    Text("Example: 0 9 * * 1-5 runs at 09:00 on weekdays.", style = MaterialTheme.typography.bodySmall)
                }
                runner.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            Button(enabled = !runner.busy && (kind != "schedule" || cron.isNotBlank()), onClick = {
                runner.run {
                    val res = api.sendJson("POST", "/routines/$routineId/triggers", buildJsonObject {
                        put("kind", kind)
                        if (label.isNotBlank()) put("label", label.trim())
                        if (kind == "schedule") { put("cronExpression", cron.trim()); put("timezone", tz.trim().ifEmpty { "UTC" }) }
                    })
                    onCreated(res as? JsonObject)
                }
            }) { Text("Add") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !runner.busy) { Text("Cancel") } },
    )
}

/** One routine trigger with enable, rotate-secret and delete actions. */
@Composable
fun TriggerCard(api: PaperclipApi, trigger: JsonObject, onChanged: () -> Unit) {
    val runner = rememberActionRunner()
    val id = trigger.str("id") ?: return
    var secret by remember { mutableStateOf<String?>(null) }
    OutlinedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(trigger.str("label") ?: humanize(trigger.str("kind") ?: "trigger"), fontWeight = FontWeight.Medium)
                    Text(listOfNotNull(
                        trigger.str("kind")?.let(::humanize),
                        trigger.str("cronExpression"),
                        trigger.str("timezone"),
                        trigger.str("nextRunAt")?.let { "next " + it.take(16).replace('T', ' ') },
                        trigger.str("lastFiredAt")?.let { "fired " + relativeTime(it) },
                    ).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                val enabled = trigger.bool("enabled") != false
                Switch(checked = enabled, enabled = !runner.busy, onCheckedChange = {
                    runner.run { api.sendJson("PATCH", "/routine-triggers/$id", buildJsonObject { put("enabled", !enabled) }); onChanged() }
                })
            }
            trigger.str("webhookUrl")?.let {
                androidx.compose.foundation.text.selection.SelectionContainer {
                    Text("Webhook URL: $it", style = MaterialTheme.typography.bodySmall)
                }
            }
            secret?.let {
                androidx.compose.foundation.text.selection.SelectionContainer {
                    Text("New secret (shown once): $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (trigger.str("kind") == "webhook") TextButton(enabled = !runner.busy, onClick = {
                    runner.run {
                        val res = api.sendJson("POST", "/routine-triggers/$id/rotate-secret") as? JsonObject
                        secret = res?.obj("secretMaterial")?.str("webhookSecret")
                    }
                }) { Text("Rotate secret") }
                TextButton(enabled = !runner.busy, onClick = {
                    runner.run { api.sendJson("DELETE", "/routine-triggers/$id"); onChanged() }
                }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            }
            runner.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        }
    }
}
