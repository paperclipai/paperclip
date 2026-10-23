package ai.paperclip.dashboard.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Result of an async load; keeps the last data visible while a refresh runs. */
class Loaded<T>(val data: T?, val error: String?, val loading: Boolean, val reload: () -> Unit)

@Composable
fun <T> rememberLoad(vararg keys: Any?, block: suspend () -> T): Loaded<T> {
    var data by remember(*keys) { mutableStateOf<T?>(null) }
    var error by remember(*keys) { mutableStateOf<String?>(null) }
    var loading by remember(*keys) { mutableStateOf(true) }
    var tick by remember(*keys) { mutableIntStateOf(0) }
    LaunchedEffect(*keys, tick) {
        loading = true
        try {
            data = block()
            error = null
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message ?: e.toString()
        }
        loading = false
    }
    return Loaded(data, error, loading) { tick++ }
}

/** Pull-to-refresh container that renders loading / error / content states for a [Loaded]. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun <T> LoadedContent(state: Loaded<T>, modifier: Modifier = Modifier, content: @Composable (T) -> Unit) {
    PullToRefreshBox(
        isRefreshing = state.loading && state.data != null,
        onRefresh = state.reload,
        modifier = modifier.fillMaxSize(),
    ) {
        val data = state.data
        when {
            data != null -> Column {
                state.error?.let { ErrorBanner(it) }
                content(data)
            }
            state.error != null -> ErrorState(state.error, state.reload)
            else -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        }
    }
}

@Composable
fun ErrorState(message: String, retry: () -> Unit) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Couldn't load", style = MaterialTheme.typography.titleMedium)
        Text(message, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
        OutlinedButton(onClick = retry) { Text("Retry") }
    }
}

@Composable
fun ErrorBanner(message: String) {
    Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
        Text(
            message,
            color = MaterialTheme.colorScheme.onErrorContainer,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        )
    }
}

@Composable
fun EmptyState(message: String) {
    Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
    }
}

@Composable
fun StatusPill(status: String, modifier: Modifier = Modifier) {
    val color = statusColor(status)
    Surface(
        color = color.copy(alpha = 0.15f),
        contentColor = color,
        shape = RoundedCornerShape(50),
        modifier = modifier,
    ) {
        Text(
            humanize(status),
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
        )
    }
}

// Status hues from the web tokens --status-task-* / --status-agent-* (ui/src/index.css).
fun statusColor(status: String): Color = when (status) {
    "done", "approved", "active", "succeeded", "achieved" -> Color(0xFF22C55E)
    "in_progress", "running" -> Color(0xFF3B82F6)
    "in_review", "revision_requested" -> Color(0xFF8B5CF6)
    "todo", "pending", "pending_approval", "open", "planned" -> Color(0xFFF59E0B)
    "blocked", "error", "rejected", "failed", "critical" -> Color(0xFFEF4444)
    "paused", "high" -> Color(0xFFF97316)
    "cancelled", "terminated", "backlog", "low", "idle", "archived" -> Color(0xFFA8AEB2)
    else -> Color(0xFF8A8F98)
}

fun humanize(s: String): String = s.replace(Regex("([a-z0-9])([A-Z])"), "$1 $2").replace('_', ' ').replace('-', ' ')
    .lowercase().replaceFirstChar { it.uppercase() }

fun money(cents: Long): String = String.format(Locale.US, "$%,.2f", cents / 100.0)

fun relativeTime(iso: String?): String {
    val t = iso?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return ""
    val d = Duration.between(t, Instant.now())
    return when {
        d.isNegative || d.seconds < 60 -> "just now"
        d.toMinutes() < 60 -> "${d.toMinutes()}m ago"
        d.toHours() < 24 -> "${d.toHours()}h ago"
        d.toDays() < 7 -> "${d.toDays()}d ago"
        else -> DateTimeFormatter.ofPattern("MMM d, yyyy").withZone(ZoneId.systemDefault()).format(t)
    }
}
