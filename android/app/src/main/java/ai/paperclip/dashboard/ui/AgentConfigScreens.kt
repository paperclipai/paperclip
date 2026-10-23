@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package ai.paperclip.dashboard.ui

import ai.paperclip.dashboard.data.Agent
import ai.paperclip.dashboard.data.PaperclipApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.net.URLEncoder

val AGENT_ROLES = listOf("ceo", "cto", "cmo", "cfo", "security", "engineer", "designer", "pm", "qa", "devops", "researcher", "general")

private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

private fun JsonElement?.display(): String = when (this) {
    null, JsonNull -> ""
    is JsonPrimitive -> contentOrNull.orEmpty()
    else -> toString()
}

/** Parses a text field back to JSON, keeping numbers, booleans and objects typed. */
private fun parseValue(api: PaperclipApi, text: String, type: String?): JsonElement {
    val t = text.trim()
    if (t.isEmpty()) return JsonNull
    return when (type) {
        "number" -> t.toLongOrNull()?.let(::JsonPrimitive) ?: t.toDoubleOrNull()?.let(::JsonPrimitive) ?: JsonPrimitive(t)
        "toggle" -> JsonPrimitive(t == "true")
        "json" -> runCatching { api.json.parseToJsonElement(t) }.getOrElse { JsonPrimitive(t) }
        else -> JsonPrimitive(text)
    }
}

/** Adapter config field from `GET /adapters/:type/config-schema`. */
private data class ConfigField(val key: String, val label: String, val type: String, val hint: String?, val group: String?, val options: List<Pair<String, String>>)

private fun parseSchema(schema: JsonObject?): List<ConfigField> = schema?.arr("fields").orEmpty().mapNotNull { f ->
    val key = f.str("key") ?: return@mapNotNull null
    ConfigField(
        key, f.str("label") ?: humanize(key), f.str("type") ?: "text", f.str("hint"), f.str("group"),
        f.arr("options").mapNotNull { o -> o.str("value")?.let { it to (o.str("label") ?: it) } },
    )
}

@Composable
private fun ConfigFieldInput(field: ConfigField, value: JsonElement?, onChange: (JsonElement) -> Unit) {
    when (field.type) {
        "toggle" -> Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(field.label)
                field.hint?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            Switch(checked = (value as? JsonPrimitive)?.booleanOrNull == true, onCheckedChange = { onChange(JsonPrimitive(it)) })
        }
        "select" -> Column {
            PickerButton(field.label, value.display().ifEmpty { null }, field.options, noneLabel = "Default") { onChange(it?.let(::JsonPrimitive) ?: JsonNull) }
            field.hint?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        else -> Column {
            OutlinedTextField(
                value.display(), {
                    onChange(when {
                        it.isBlank() -> JsonNull
                        field.type == "number" -> it.trim().toLongOrNull()?.let(::JsonPrimitive) ?: it.trim().toDoubleOrNull()?.let(::JsonPrimitive) ?: JsonPrimitive(it)
                        else -> JsonPrimitive(it)
                    })
                },
                label = { Text(field.label) }, modifier = Modifier.fillMaxWidth(),
                singleLine = field.type != "textarea", minLines = if (field.type == "textarea") 3 else 1,
                keyboardOptions = if (field.type == "number") KeyboardOptions(keyboardType = KeyboardType.Number) else KeyboardOptions.Default,
                supportingText = field.hint?.let { h -> { Text(h) } },
            )
            if (field.type == "combobox" && field.options.isNotEmpty()) {
                PickerButton("Pick", value.display().ifEmpty { null }, field.options, noneLabel = null) { it?.let { v -> onChange(JsonPrimitive(v)) } }
            }
        }
    }
}

/**
 * Agent "Configuration" tab: adapter type, model and the adapter's declared fields,
 * plus any other adapter settings as raw values. Saves only the keys you changed,
 * so redacted secrets in the loaded config are never written back.
 */
@Composable
fun AgentConfigTab(api: PaperclipApi, companyId: String, agent: Agent, onSaved: () -> Unit) {
    val state = rememberLoad(agent.id) {
        val config = api.getJson("/agents/${agent.id}/configuration?companyId=$companyId") as JsonObject
        val adapters = runCatching { api.getJson("/adapters?companyId=$companyId").asItems() }.getOrDefault(emptyList())
        val revisions = runCatching { api.getJson("/agents/${agent.id}/config-revisions?companyId=$companyId").asItems() }.getOrDefault(emptyList())
        Triple(config, adapters, revisions)
    }
    LoadedContent(state) { (config, adapters, revisions) ->
        val runner = rememberActionRunner()
        val original = config.obj("adapterConfig") ?: JsonObject(emptyMap())
        var adapterType by remember(config) { mutableStateOf(config.str("adapterType") ?: agent.adapterType) }
        val edits = remember(config) { mutableStateMapOf<String, JsonElement>() }
        val schema = rememberLoad(adapterType) {
            parseSchema(runCatching { api.getJson("/adapters/${enc(adapterType)}/config-schema") as JsonObject }.getOrNull())
        }.data.orEmpty()
        val models = rememberLoad(adapterType) {
            runCatching { api.getJson("/companies/$companyId/adapters/${enc(adapterType)}/models").asItems() }.getOrDefault(emptyList())
                .mapNotNull { m -> m.str("id")?.let { it to (m.str("label") ?: it) } }
        }.data.orEmpty()
        val current: (String) -> JsonElement? = { k -> edits[k] ?: original[k] }
        var newKey by remember { mutableStateOf("") }
        var confirmRollback by remember { mutableStateOf<JsonObject?>(null) }

        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                PickerButton("Adapter", adapterType,
                    adapters.filter { it.bool("disabled") != true }.mapNotNull { a -> a.str("type")?.let { it to (a.str("label") ?: it) } },
                    noneLabel = null) { it?.let { t -> adapterType = t } }
                if (models.isNotEmpty() && schema.none { it.key == "model" }) {
                    PickerButton("Model", current("model").display().ifEmpty { null }, models, noneLabel = "Default") {
                        edits["model"] = it?.let(::JsonPrimitive) ?: JsonNull
                    }
                }
            }
            if (adapterType != (config.str("adapterType") ?: agent.adapterType)) {
                Text("Changing the adapter resets settings that the new adapter does not use.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
            schema.groupBy { it.group }.forEach { (group, fields) ->
                group?.let { Text(humanize(it), style = MaterialTheme.typography.titleSmall) }
                fields.forEach { f ->
                    val withModels = if (f.key == "model" && f.options.isEmpty()) f.copy(type = "combobox", options = models) else f
                    ConfigFieldInput(withModels, current(f.key)) { edits[f.key] = it }
                }
            }
            val extraKeys = (original.keys + edits.keys).filter { k -> schema.none { it.key == k } && k != "model" }.distinct().sorted()
            if (extraKeys.isNotEmpty() || schema.isEmpty()) {
                HorizontalDivider()
                Text("Other settings", style = MaterialTheme.typography.titleSmall)
                Text("Values are JSON when they are objects or lists. Secrets show as redacted; leave them unchanged to keep them.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            extraKeys.forEach { k ->
                val v = current(k)
                val type = when {
                    v is JsonPrimitive && v.booleanOrNull != null && !v.isString -> "toggle"
                    v is JsonPrimitive && (v.longOrNull != null || v.doubleOrNull != null) && !v.isString -> "number"
                    v is JsonObject || v is kotlinx.serialization.json.JsonArray -> "json"
                    else -> "text"
                }
                var text by remember(k, config) { mutableStateOf(v.display()) }
                if (type == "toggle") {
                    ConfigFieldInput(ConfigField(k, k, "toggle", null, null, emptyList()), v) { edits[k] = it }
                } else OutlinedTextField(
                    text, { text = it; edits[k] = parseValue(api, it, type) },
                    label = { Text(k) }, modifier = Modifier.fillMaxWidth(),
                    singleLine = type != "json", minLines = if (type == "json") 3 else 1,
                    textStyle = if (type == "json") MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace) else MaterialTheme.typography.bodyLarge,
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(newKey, { newKey = it.trim() }, label = { Text("Add setting key") }, singleLine = true, modifier = Modifier.weight(1f))
                TextButton(enabled = newKey.isNotEmpty() && current(newKey) == null, onClick = { edits[newKey] = JsonPrimitive(""); newKey = "" }) { Text("Add") }
            }
            ActionMessages(runner)
            Button(
                enabled = !runner.busy && (edits.isNotEmpty() || adapterType != (config.str("adapterType") ?: agent.adapterType)),
                onClick = {
                    runner.run {
                        api.updateAgent(agent.id, companyId, buildJsonObject {
                            put("adapterType", adapterType)
                            put("adapterConfig", JsonObject(edits.toMap()))
                        })
                        runner.notice = "Configuration saved"
                        onSaved()
                        state.reload()
                    }
                },
            ) { Text("Save configuration") }

            if (revisions.isNotEmpty()) {
                HorizontalDivider()
                Text("Revision history", style = MaterialTheme.typography.titleMedium)
                revisions.take(20).forEach { r ->
                    OutlinedCard(Modifier.fillMaxWidth()) {
                        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(relativeTime(r.str("createdAt")) + " · " + humanize(r.str("source") ?: "update"), fontWeight = FontWeight.Medium)
                                Text(r.strings("changedKeys").joinToString(", ").ifEmpty { "No key changes" },
                                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            TextButton(enabled = !runner.busy, onClick = { confirmRollback = r }) { Text("Restore") }
                        }
                    }
                }
            }
        }
        confirmRollback?.let { r ->
            AlertDialog(
                onDismissRequest = { confirmRollback = null },
                title = { Text("Restore this configuration?") },
                text = { Text("The agent goes back to the settings from ${relativeTime(r.str("createdAt"))}. This adds a new revision.") },
                confirmButton = {
                    TextButton(onClick = {
                        confirmRollback = null
                        runner.run {
                            api.sendJson("POST", "/agents/${agent.id}/config-revisions/${r.str("id")}/rollback?companyId=$companyId")
                            onSaved(); state.reload()
                        }
                    }) { Text("Restore") }
                },
                dismissButton = { TextButton(onClick = { confirmRollback = null }) { Text("Cancel") } },
            )
        }
    }
}

/** Agent "Instructions" tab: list, open, edit, create and delete instruction files. */
@Composable
fun AgentInstructionsTab(api: PaperclipApi, companyId: String, agentId: String) {
    val base = "/agents/$agentId/instructions-bundle"
    val bundle = rememberLoad(agentId) { api.getJson("$base?companyId=$companyId") as JsonObject }
    var openPath by rememberSaveable { mutableStateOf<String?>(null) }
    var creating by remember { mutableStateOf(false) }
    val path = openPath
    if (path != null) {
        InstructionFileEditor(api, companyId, agentId, path, isNew = creating) {
            openPath = null; creating = false; bundle.reload()
        }
        return
    }
    LoadedContent(bundle) { b ->
        var newPath by remember { mutableStateOf("") }
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("Entry file: ${b.str("entryFile") ?: "AGENTS.md"}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            b.strings("warnings").forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            val files = b.arr("files")
            if (files.isEmpty()) EmptyState("No instruction files")
            files.forEach { f ->
                val p = f.str("path") ?: return@forEach
                OutlinedCard(Modifier.fillMaxWidth().clickable(enabled = f.bool("binary") != true) { openPath = p }) {
                    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(p, fontWeight = if (f.bool("isEntryFile") == true) FontWeight.SemiBold else FontWeight.Normal)
                            Text(listOfNotNull(
                                "entry".takeIf { f.bool("isEntryFile") == true },
                                f.int("size")?.let { formatBytes(it.toLong()) },
                                "read-only".takeIf { f.bool("editable") == false },
                                "deprecated".takeIf { f.bool("deprecated") == true },
                            ).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
            if (b.bool("editable") != false) {
                HorizontalDivider()
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(newPath, { newPath = it.trim() }, label = { Text("New file path") }, placeholder = { Text("notes/style.md") },
                        singleLine = true, modifier = Modifier.weight(1f))
                    TextButton(enabled = newPath.isNotEmpty() && files.none { it.str("path") == newPath }, onClick = {
                        creating = true; openPath = newPath
                    }) { Text("Create") }
                }
            }
        }
    }
}

@Composable
private fun InstructionFileEditor(api: PaperclipApi, companyId: String, agentId: String, path: String, isNew: Boolean, onClose: () -> Unit) {
    val base = "/agents/$agentId/instructions-bundle"
    val state = rememberLoad(path, isNew) {
        if (isNew) JsonObject(mapOf("path" to JsonPrimitive(path), "content" to JsonPrimitive(""), "editable" to JsonPrimitive(true)))
        else api.getJson("$base/file?path=${enc(path)}&companyId=$companyId") as JsonObject
    }
    LoadedContent(state) { file ->
        val runner = rememberActionRunner()
        var text by remember(file) { mutableStateOf(file.str("content").orEmpty()) }
        var preview by remember { mutableStateOf(false) }
        var confirmDelete by remember { mutableStateOf(false) }
        val editable = file.bool("editable") != false
        val hash = file.str("contentHash")
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(path, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                TextButton(onClick = onClose) { Text("Close") }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { preview = !preview }) { Text(if (preview) "Edit" else "Preview") }
                if (!isNew && editable) TextButton(onClick = { confirmDelete = true }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            }
            if (preview) Markdown(text)
            else OutlinedTextField(
                text, { text = it }, enabled = editable, modifier = Modifier.fillMaxWidth(), minLines = 12,
                textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            )
            ActionMessages(runner)
            if (editable) Button(enabled = !runner.busy && text != file.str("content").orEmpty(), onClick = {
                runner.run {
                    api.sendJson("PUT", "$base/file?companyId=$companyId", buildJsonObject {
                        put("path", path)
                        put("content", text)
                        if (isNew) put("baseRevisionId", JsonNull) else if (hash != null) put("baseHash", hash) else put("baseRevisionId", JsonNull)
                    })
                    onClose()
                }
            }) { Text("Save") }
        }
        if (confirmDelete) AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete $path?") },
            text = { Text("The agent stops reading this file.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = false
                    runner.run {
                        api.sendJson("DELETE", "$base/file?path=${enc(path)}&companyId=$companyId" + (hash?.let { "&baseHash=$it" } ?: ""))
                        onClose()
                    }
                }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
        )
    }
}

/** Hire a new agent (`POST /companies/:cid/agent-hires`); may create a pending approval. */
@Composable
fun HireAgentScreen(api: PaperclipApi, companyId: String, agentsById: Map<String, Agent>, onHired: (agentId: String, approvalId: String?) -> Unit) {
    val adapters = rememberLoad(companyId) { api.getJson("/adapters?companyId=$companyId").asItems().filter { it.bool("disabled") != true } }
    LoadedContent(adapters) { list ->
        val runner = rememberActionRunner()
        var name by rememberSaveable { mutableStateOf("") }
        var title by rememberSaveable { mutableStateOf("") }
        var role by rememberSaveable { mutableStateOf("general") }
        var adapterType by rememberSaveable { mutableStateOf(list.firstOrNull { it.str("type") == "claude_local" }?.str("type") ?: list.firstOrNull()?.str("type") ?: "claude_local") }
        var model by rememberSaveable { mutableStateOf<String?>(null) }
        var reportsTo by rememberSaveable { mutableStateOf<String?>(null) }
        var capabilities by rememberSaveable { mutableStateOf("") }
        var budget by rememberSaveable { mutableStateOf("") }
        val models = rememberLoad(adapterType) {
            runCatching { api.getJson("/companies/$companyId/adapters/${enc(adapterType)}/models").asItems() }.getOrDefault(emptyList())
                .mapNotNull { m -> m.str("id")?.let { it to (m.str("label") ?: it) } }
        }.data.orEmpty()
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(title, { title = it }, label = { Text("Title (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                ChoiceButton("Role", role, AGENT_ROLES) { role = it }
                PickerButton("Adapter", adapterType, list.mapNotNull { a -> a.str("type")?.let { it to (a.str("label") ?: it) } }, noneLabel = null) {
                    it?.let { t -> adapterType = t; model = null }
                }
                if (models.isNotEmpty()) PickerButton("Model", model, models, noneLabel = "Default") { model = it }
                PickerButton("Reports to", reportsTo,
                    agentsById.values.filter { it.status != "terminated" }.sortedBy { it.name }.map { it.id to it.name }) { reportsTo = it }
            }
            OutlinedTextField(capabilities, { capabilities = it }, label = { Text("What this agent does") }, minLines = 3, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(budget, { budget = it.filter { c -> c.isDigit() || c == '.' } }, label = { Text("Monthly budget (USD, 0 = none)") },
                singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
            Text("Set adapter details such as working folder and permissions on the agent's Configuration tab after hiring.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            ActionMessages(runner)
            Button(enabled = !runner.busy && name.isNotBlank(), onClick = {
                runner.run {
                    val res = api.sendJson("POST", "/companies/$companyId/agent-hires", buildJsonObject {
                        put("name", name.trim())
                        if (title.isNotBlank()) put("title", title.trim())
                        put("role", role)
                        put("adapterType", adapterType)
                        put("adapterConfig", buildJsonObject { model?.let { put("model", it) } })
                        reportsTo?.let { put("reportsTo", it) }
                        if (capabilities.isNotBlank()) put("capabilities", capabilities.trim())
                        budget.toDoubleOrNull()?.let { put("budgetMonthlyCents", (it * 100).toLong()) }
                    }) as JsonObject
                    val agentId = res.obj("agent")?.str("id") ?: error("Server did not return the new agent")
                    onHired(agentId, res.obj("approval")?.str("id"))
                }
            }) { Text("Hire agent") }
        }
    }
}
