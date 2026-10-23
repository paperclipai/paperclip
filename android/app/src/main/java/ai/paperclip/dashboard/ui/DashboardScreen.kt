package ai.paperclip.dashboard.ui

import ai.paperclip.dashboard.data.DashboardSummary
import ai.paperclip.dashboard.data.PaperclipApi
import ai.paperclip.dashboard.data.RunActivityDay
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

@Composable
fun DashboardScreen(
    api: PaperclipApi,
    companyId: String,
    onOpenIssues: (status: String?) -> Unit,
    onOpenAgents: () -> Unit,
    onOpenApprovals: () -> Unit,
) {
    val state = rememberLoad(companyId) { api.dashboard(companyId) }
    LoadedContent(state) { d -> DashboardBody(d, onOpenIssues, onOpenAgents, onOpenApprovals) }
}

@Composable
private fun DashboardBody(
    d: DashboardSummary,
    onOpenIssues: (String?) -> Unit,
    onOpenAgents: () -> Unit,
    onOpenApprovals: () -> Unit,
) {
    LazyColumn(
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (d.pendingApprovals > 0 || d.budgets.activeIncidents > 0) {
            item {
                AttentionCard(d, onOpenApprovals)
            }
        }
        item {
            Section("Tasks") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Metric("Open", d.tasks.open, null, Modifier.weight(1f)) { onOpenIssues(null) }
                    Metric("In progress", d.tasks.inProgress, statusColor("in_progress"), Modifier.weight(1f)) { onOpenIssues("in_progress") }
                    Metric("Blocked", d.tasks.blocked, statusColor("blocked"), Modifier.weight(1f)) { onOpenIssues("blocked") }
                    Metric("Done", d.tasks.done, statusColor("done"), Modifier.weight(1f)) { onOpenIssues("done") }
                }
            }
        }
        item {
            Section("Agents") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Metric("Active", d.agents.active, statusColor("active"), Modifier.weight(1f), onOpenAgents)
                    Metric("Running", d.agents.running, statusColor("running"), Modifier.weight(1f), onOpenAgents)
                    Metric("Paused", d.agents.paused, statusColor("paused"), Modifier.weight(1f), onOpenAgents)
                    Metric("Error", d.agents.error, statusColor("error"), Modifier.weight(1f), onOpenAgents)
                }
            }
        }
        item { CostCard(d) }
        item {
            Section("Budgets") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Metric("Incidents", d.budgets.activeIncidents, statusColor("error"), Modifier.weight(1f))
                    Metric("Pending", d.budgets.pendingApprovals, statusColor("pending"), Modifier.weight(1f), onOpenApprovals)
                    Metric("Paused agents", d.budgets.pausedAgents, statusColor("paused"), Modifier.weight(1f))
                    Metric("Paused projects", d.budgets.pausedProjects, statusColor("paused"), Modifier.weight(1f))
                }
            }
        }
        item { RunActivityCard(d.runActivity) }
    }
}

@Composable
private fun AttentionCard(d: DashboardSummary, onOpenApprovals: () -> Unit) {
    OutlinedCard(
        colors = CardDefaults.outlinedCardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer),
        modifier = Modifier.fillMaxWidth().clickable(onClick = onOpenApprovals),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("Needs attention", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            if (d.pendingApprovals > 0) Text("${d.pendingApprovals} approval(s) waiting for the board")
            if (d.budgets.activeIncidents > 0) Text("${d.budgets.activeIncidents} active budget incident(s)")
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        content()
    }
}

@Composable
private fun Metric(label: String, value: Int, accent: Color?, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    OutlinedCard(modifier = modifier.then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)) {
        Column(Modifier.padding(12.dp)) {
            Text(
                value.toString(),
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.SemiBold,
                color = if (accent != null && value > 0) accent else MaterialTheme.colorScheme.onSurface,
            )
            Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, minLines = 2, maxLines = 2)
        }
    }
}

@Composable
private fun CostCard(d: DashboardSummary) {
    OutlinedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Spend this month", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(verticalAlignment = Alignment.Bottom) {
                Text(money(d.costs.monthSpendCents), style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
                if (d.costs.monthBudgetCents > 0) {
                    Text(
                        "  of ${money(d.costs.monthBudgetCents)}",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(bottom = 4.dp),
                    )
                }
            }
            if (d.costs.monthBudgetCents > 0) {
                val pct = (d.costs.monthUtilizationPercent / 100.0).toFloat().coerceIn(0f, 1f)
                LinearProgressIndicator(
                    progress = { pct },
                    color = when {
                        d.costs.monthUtilizationPercent >= 100 -> statusColor("error")
                        d.costs.monthUtilizationPercent >= 80 -> statusColor("paused")
                        else -> MaterialTheme.colorScheme.primary
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
                Text("${"%.1f".format(d.costs.monthUtilizationPercent)}% of budget used", style = MaterialTheme.typography.bodySmall)
            } else {
                Text("No monthly budget set", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

private val SUCCEEDED = Color(0xFF2E9D5B)
private val RECOVERED = Color(0xFF2F7DE1)
private val FAILED = Color(0xFFD64545)
private val OTHER = Color(0xFF8A8F98)

@Composable
private fun RunActivityCard(days: List<RunActivityDay>) {
    OutlinedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val total = days.sumOf { it.total }
            Text("Runs, last ${days.size} days", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(
                "$total runs · ${days.sumOf { it.failed }} failed",
                style = MaterialTheme.typography.bodyMedium,
            )
            if (total == 0) {
                Text("No runs yet", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                val max = days.maxOf { it.total }.coerceAtLeast(1)
                Canvas(Modifier.fillMaxWidth().height(120.dp)) {
                    val slot = size.width / days.size
                    val barWidth = slot * 0.7f
                    days.forEachIndexed { i, day ->
                        var top = size.height
                        val x = i * slot + (slot - barWidth) / 2
                        for ((count, color) in listOf(day.succeeded to SUCCEEDED, day.recovered to RECOVERED, day.other to OTHER, day.failed to FAILED)) {
                            if (count == 0) continue
                            val h = size.height * count / max
                            top -= h
                            drawRect(color, Offset(x, top), Size(barWidth, h))
                        }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Legend("Succeeded", SUCCEEDED)
                    Legend("Recovered", RECOVERED)
                    Legend("Failed", FAILED)
                    Legend("Other", OTHER)
                }
            }
        }
    }
}

@Composable
private fun Legend(label: String, color: Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Surface(color = color, shape = CircleShape, modifier = Modifier.size(8.dp)) {}
        Spacer(Modifier.size(4.dp))
        Text(label, style = MaterialTheme.typography.labelSmall)
    }
}
