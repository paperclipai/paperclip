@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package ai.paperclip.dashboard.ui

import ai.paperclip.dashboard.data.PaperclipApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SecondaryScrollableTabRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

private fun JsonObject.pluginName(): String =
    obj("manifestJson")?.str("displayName") ?: str("displayName", "pluginKey", "packageName") ?: "Plugin"

/** Plugin manager: installed plugins, bundled examples and npm install. Writes need an instance admin. */
@Composable
fun PluginsScreen(api: PaperclipApi, onOpen: (String) -> Unit) {
    var version by remember { mutableIntStateOf(0) }
    var installing by remember { mutableStateOf(false) }
    val runner = rememberActionRunner()
    val state = rememberLoad(version) {
        api.plugins().asItems() to runCatching { api.pluginExamples().asItems() }.getOrDefault(emptyList())
    }
    Box(Modifier.fillMaxSize()) {
        LoadedContent(state) { (installed, examples) ->
            val installedKeys = installed.mapNotNull { it.str("pluginKey") }.toSet()
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 88.dp)) {
                item { ActionMessages(runner) }
                item { SectionLabel("Installed") }
                if (installed.isEmpty()) item { EmptyState("No plugins installed") }
                items(installed, key = { "p:" + (it.str("id") ?: it.pluginName()) }) { p ->
                    Row(Modifier.fillMaxWidth().padding(end = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.weight(1f)) {
                            ListRow(p.pluginName(), listOfNotNull(p.str("packageName"), p.str("version")?.let { "v$it" },
                                p.str("lastError")).joinToString(" · "), p.str("status")) { p.str("id")?.let(onOpen) }
                        }
                        val enabled = p.str("status") != "disabled"
                        Switch(checked = enabled, enabled = !runner.busy, onCheckedChange = {
                            runner.run { api.setPluginEnabled(p.str("id")!!, !enabled); version++ }
                        })
                    }
                }
                val available = examples.filter { it.str("pluginKey") !in installedKeys }
                if (available.isNotEmpty()) {
                    item { SectionLabel("Available") }
                    items(available, key = { "e:" + (it.str("packageName") ?: it.titleText()) }) { e ->
                        Row(Modifier.fillMaxWidth().padding(end = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.weight(1f)) {
                                ListRow(e.str("displayName") ?: e.titleText(), listOfNotNull(e.str("tag")?.let(::humanize),
                                    if (e.bool("experimental") == true) "Experimental" else null,
                                    e.str("description")).joinToString(" · "))
                            }
                            OutlinedButton(enabled = !runner.busy, onClick = {
                                runner.run {
                                    val path = e.str("localPath")
                                    api.installPlugin(path ?: e.str("packageName")!!, null, isLocalPath = path != null)
                                    runner.notice = "Installed ${e.str("displayName") ?: "plugin"}"
                                    version++
                                }
                            }) { Text("Install") }
                        }
                    }
                }
            }
        }
        ExtendedFloatingActionButton(
            onClick = { installing = true },
            icon = { Icon(Icons.Default.Add, null) },
            text = { Text("Install from npm") },
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        )
    }
    if (installing) InstallPluginDialog(api, onDismiss = { installing = false }) { id ->
        installing = false
        version++
        id?.let(onOpen)
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 4.dp))
}

@Composable
private fun InstallPluginDialog(api: PaperclipApi, onDismiss: () -> Unit, onDone: (String?) -> Unit) {
    var name by rememberSaveable { mutableStateOf("") }
    var ver by rememberSaveable { mutableStateOf("") }
    val runner = rememberActionRunner()
    AlertDialog(
        onDismissRequest = { if (!runner.busy) onDismiss() },
        title = { Text("Install plugin") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(name, { name = it }, label = { Text("npm package name") }, singleLine = true,
                    placeholder = { Text("@paperclipai/plugin-example") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(ver, { ver = it }, label = { Text("Version (optional)") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth())
                runner.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            Button(enabled = name.isNotBlank() && !runner.busy, onClick = {
                runner.run { onDone((api.installPlugin(name.trim(), ver.trim(), false) as? JsonObject)?.str("id")) }
            }) { Text(if (runner.busy) "Installing…" else "Install") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !runner.busy) { Text("Cancel") } },
    )
}

private val PLUGIN_TABS = listOf("Configuration", "Status", "Logs")

@Composable
fun PluginDetailScreen(api: PaperclipApi, companyId: String, pluginId: String, onUninstalled: () -> Unit) {
    var version by remember { mutableIntStateOf(0) }
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var confirmUninstall by remember { mutableStateOf(false) }
    val runner = rememberActionRunner()
    val state = rememberLoad(pluginId, version) { api.plugin(pluginId) as JsonObject }
    LoadedContent(state) { p ->
        Column(Modifier.fillMaxSize()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(p.pluginName(), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
                    p.str("status")?.let { StatusPill(it) }
                }
                Text(listOfNotNull(p.str("packageName"), p.str("version")?.let { "v$it" }).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                p.obj("manifestJson")?.str("description")?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                p.str("lastError")?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    val enabled = p.str("status") != "disabled"
                    OutlinedButton(enabled = !runner.busy, onClick = {
                        runner.run { api.setPluginEnabled(pluginId, !enabled); version++ }
                    }) { Text(if (enabled) "Disable" else "Enable") }
                    OutlinedButton(enabled = !runner.busy, onClick = {
                        runner.run { api.upgradePlugin(pluginId); runner.notice = "Upgraded"; version++ }
                    }) { Text("Upgrade") }
                    TextButton(enabled = !runner.busy, onClick = { confirmUninstall = true }) {
                        Text("Uninstall", color = MaterialTheme.colorScheme.error)
                    }
                }
                ActionMessages(runner)
            }
            SecondaryScrollableTabRow(selectedTabIndex = tab, edgePadding = 0.dp) {
                PLUGIN_TABS.forEachIndexed { i, t -> Tab(selected = tab == i, onClick = { tab = i }, text = { Text(t) }) }
            }
            when (tab) {
                0 -> PluginConfig(api, companyId, pluginId, p.obj("manifestJson")?.obj("instanceConfigSchema"), p.bool("supportsConfigTest") == true)
                1 -> PluginStatus(api, pluginId)
                else -> PluginLogs(api, pluginId)
            }
        }
    }
    if (confirmUninstall) AlertDialog(
        onDismissRequest = { confirmUninstall = false },
        title = { Text("Uninstall plugin?") },
        text = { Text("Uninstall keeps its stored data. Uninstall and purge also deletes the plugin's data.") },
        confirmButton = {
            TextButton(onClick = {
                confirmUninstall = false
                runner.run { api.uninstallPlugin(pluginId, purge = false); onUninstalled() }
            }) { Text("Uninstall") }
        },
        dismissButton = {
            TextButton(onClick = {
                confirmUninstall = false
                runner.run { api.uninstallPlugin(pluginId, purge = true); onUninstalled() }
            }) { Text("Uninstall and purge", color = MaterialTheme.colorScheme.error) }
        },
    )
}

@Composable
private fun PluginConfig(api: PaperclipApi, companyId: String, pluginId: String, schema: JsonObject?, supportsTest: Boolean) {
    val runner = rememberActionRunner()
    val state = rememberLoad(pluginId, companyId) {
        val cfg = api.pluginConfig(pluginId, companyId) as? JsonObject
        (cfg?.obj("configJson") ?: JsonObject(emptyMap())) to runCatching { api.secrets(companyId).asItems() }.getOrDefault(emptyList())
    }
    LoadedContent(state) { (initial, secrets) ->
        var value by remember(initial) { mutableStateOf(initial) }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (schema == null || schema.obj("properties").isNullOrEmpty()) {
                item { Text("This plugin has no settings for this company.", style = MaterialTheme.typography.bodyMedium) }
                return@LazyColumn
            }
            item { SchemaObjectFields(schema, value, secrets) { value = it } }
            item {
                ActionMessages(runner)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (supportsTest) OutlinedButton(enabled = !runner.busy, onClick = {
                        runner.run {
                            val res = api.savePluginConfig(pluginId, companyId, value, test = true) as? JsonObject
                            val ok = res?.bool("valid") == true
                            val msg = res?.str("message")
                            if (ok) runner.notice = msg ?: "Configuration works" else runner.error = msg ?: "Configuration test failed"
                        }
                    }) { Text("Test") }
                    Button(enabled = !runner.busy, onClick = {
                        runner.run { api.savePluginConfig(pluginId, companyId, value); runner.notice = "Saved" }
                    }) { Text("Save") }
                }
            }
        }
    }
}

/**
 * Native take on the web JsonSchemaForm: strings, numbers, booleans, enums, nested objects,
 * secret-ref pickers and raw JSON for arrays. `x-paperclip-advanced` fields are collapsed.
 */
@Composable
fun SchemaObjectFields(schema: JsonObject, value: JsonObject, secrets: List<JsonObject>, onChange: (JsonObject) -> Unit) {
    val props = schema.obj("properties") ?: return
    val required = schema.strings("required").toSet()
    var showAdvanced by rememberSaveable { mutableStateOf(false) }
    val (advanced, basic) = props.entries.partition { (it.value as? JsonObject)?.bool("x-paperclip-advanced") == true }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        basic.forEach { (key, s) ->
            SchemaField(key, s as? JsonObject ?: JsonObject(emptyMap()), value[key], key in required, secrets) { v ->
                onChange(JsonObject(value.toMutableMap().apply { if (v == null) remove(key) else put(key, v) }))
            }
        }
        if (advanced.isNotEmpty()) {
            TextButton(onClick = { showAdvanced = !showAdvanced }) {
                Text(if (showAdvanced) "Hide advanced settings" else "Show advanced settings (${advanced.size})")
            }
            if (showAdvanced) advanced.forEach { (key, s) ->
                SchemaField(key, s as JsonObject, value[key], key in required, secrets) { v ->
                    onChange(JsonObject(value.toMutableMap().apply { if (v == null) remove(key) else put(key, v) }))
                }
            }
        }
    }
}

private val prettyJson = Json { prettyPrint = true }

@Composable
private fun SchemaField(
    key: String,
    schema: JsonObject,
    current: JsonElement?,
    required: Boolean,
    secrets: List<JsonObject>,
    onChange: (JsonElement?) -> Unit,
) {
    val label = (schema.str("title") ?: humanize(key)) + if (required) " *" else ""
    val help = schema.str("description")
    val type = schema.str("type") ?: if (schema["enum"] != null) "string" else if (schema["properties"] != null) "object" else "string"
    val enum = (schema["enum"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
    val prim = (current as? JsonPrimitive)?.takeIf { current !is JsonNull }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        when {
            schema.str("format") == "secret-ref" -> SecretRefField(label, current as? JsonObject, secrets, onChange)
            enum != null -> ChoiceField(label, prim?.contentOrNull, (if (required) emptyList() else listOf<String?>(null)) + enum) {
                onChange(it?.let(::JsonPrimitive))
            }
            type == "boolean" -> Row(verticalAlignment = Alignment.CenterVertically) {
                Text(label, modifier = Modifier.weight(1f))
                Switch(checked = prim?.booleanOrNull ?: (schema["default"] as? JsonPrimitive)?.booleanOrNull ?: false,
                    onCheckedChange = { onChange(JsonPrimitive(it)) })
            }
            type == "number" || type == "integer" -> {
                var text by remember(current) { mutableStateOf(prim?.contentOrNull.orEmpty()) }
                OutlinedTextField(text, { t ->
                    text = t
                    when {
                        t.isBlank() -> onChange(null)
                        type == "integer" -> t.toLongOrNull()?.let { onChange(JsonPrimitive(it)) }
                        else -> t.toDoubleOrNull()?.let { onChange(JsonPrimitive(it)) }
                    }
                }, label = { Text(label) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    placeholder = schema["default"]?.let { d -> { Text(d.toString()) } })
                val n = prim?.doubleOrNull ?: prim?.longOrNull?.toDouble()
                val min = (schema["minimum"] as? JsonPrimitive)?.doubleOrNull
                val max = (schema["maximum"] as? JsonPrimitive)?.doubleOrNull
                if (n != null && ((min != null && n < min) || (max != null && n > max)))
                    Text("Must be between ${min ?: "-∞"} and ${max ?: "∞"}", color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall)
            }
            type == "object" && schema["properties"] != null -> OutlinedCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(label, fontWeight = FontWeight.SemiBold)
                    SchemaObjectFields(schema, current as? JsonObject ?: JsonObject(emptyMap()), secrets) { onChange(it) }
                }
            }
            type == "array" || type == "object" -> {
                var text by remember(key) { mutableStateOf(current?.let { prettyJson.encodeToString(JsonElement.serializer(), it) }.orEmpty()) }
                var bad by remember { mutableStateOf(false) }
                OutlinedTextField(text, { t ->
                    text = t
                    val parsed = if (t.isBlank()) null else runCatching { Json.parseToJsonElement(t) }.getOrNull()
                    bad = t.isNotBlank() && parsed == null
                    if (!bad) onChange(parsed)
                }, label = { Text("$label (JSON)") }, isError = bad, minLines = 3, modifier = Modifier.fillMaxWidth(),
                    textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
            }
            else -> {
                val multiline = schema.str("format") == "textarea" || ((schema["maxLength"] as? JsonPrimitive)?.longOrNull ?: 0) > 200
                val secret = schema.str("format") == "password" || schema.bool("writeOnly") == true
                val text = prim?.contentOrNull.orEmpty()
                OutlinedTextField(text, { onChange(if (it.isEmpty()) null else JsonPrimitive(it)) },
                    label = { Text(label) }, singleLine = !multiline, minLines = if (multiline) 3 else 1,
                    visualTransformation = if (secret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
                    placeholder = (schema["default"] as? JsonPrimitive)?.contentOrNull?.let { d -> { Text(d) } },
                    isError = schema.str("pattern")?.let { p -> text.isNotEmpty() && runCatching { !Regex(p).containsMatchIn(text) }.getOrDefault(false) } == true,
                    modifier = Modifier.fillMaxWidth())
            }
        }
        help?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
private fun ChoiceField(label: String, value: String?, options: List<String?>, onPick: (String?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = it }) {
        OutlinedTextField(value ?: "Not configured", {}, readOnly = true, label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(open) },
            modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable))
        ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { o ->
                DropdownMenuItem(text = { Text(o ?: "Not configured") }, onClick = { open = false; onPick(o) })
            }
        }
    }
}

/** Binds a company secret, matching the web SecretBindingPicker value `{type: "secret_ref", secretId}`. */
@Composable
private fun SecretRefField(label: String, current: JsonObject?, secrets: List<JsonObject>, onChange: (JsonElement?) -> Unit) {
    val currentId = current?.str("secretId")
    val names = secrets.associate { (it.str("id") ?: "") to it.titleText() }
    ChoiceField(label, currentId?.let { names[it] ?: it }, listOf<String?>(null) + secrets.mapNotNull { it.str("id") }.map { names[it] }) { picked ->
        val id = names.entries.firstOrNull { it.value == picked }?.key
        onChange(id?.let { JsonObject(mapOf("type" to JsonPrimitive("secret_ref"), "secretId" to JsonPrimitive(it))) })
    }
}

@Composable
private fun PluginStatus(api: PaperclipApi, pluginId: String) {
    val state = rememberLoad(pluginId) { api.pluginHealth(pluginId) as JsonObject }
    LoadedContent(state) { h ->
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                Text(if (h.bool("healthy") == true) "Healthy" else "Unhealthy", style = MaterialTheme.typography.titleMedium,
                    color = if (h.bool("healthy") == true) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error)
                h.str("lastError")?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
            items(h.arr("checks"), key = { it.str("name", "id") ?: it.toString() }) { c ->
                ListRow(c.str("name", "id") ?: "Check", c.str("message", "detail"), c.str("status")
                    ?: c.bool("ok")?.let { if (it) "ok" else "failed" })
            }
        }
    }
}

@Composable
private fun PluginLogs(api: PaperclipApi, pluginId: String) {
    val state = rememberLoad(pluginId) { api.pluginLogs(pluginId).asItems() }
    LaunchedEffect(Unit) {}
    LoadedContent(state) { logs ->
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp)) {
            if (logs.isEmpty()) item { EmptyState("No log entries") }
            items(logs, key = { it.str("id") ?: it.toString() }) { l ->
                Column(Modifier.padding(vertical = 4.dp)) {
                    Text("${l.str("level")?.uppercase() ?: "INFO"} · ${relativeTime(l.str("createdAt"))}",
                        style = MaterialTheme.typography.labelSmall,
                        color = if (l.str("level") == "error") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(l.str("message").orEmpty(), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
                }
                HorizontalDivider()
            }
        }
    }
}
