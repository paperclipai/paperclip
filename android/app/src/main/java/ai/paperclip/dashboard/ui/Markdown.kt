package ai.paperclip.dashboard.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp

// ponytail: block-level subset of CommonMark (headings, lists, quotes, fences, rules,
// pipe tables as monospace) plus inline bold/italic/code/links. Swap for a markdown
// library if agents start emitting HTML or nested lists that matter.

private sealed interface Block {
    data class Heading(val level: Int, val text: String) : Block
    data class Para(val text: String) : Block
    data class Bullet(val marker: String, val text: String, val indent: Int) : Block
    data class Quote(val text: String) : Block
    data class Code(val text: String) : Block
    data object Rule : Block
}

private fun parseBlocks(src: String): List<Block> {
    val out = mutableListOf<Block>()
    val lines = src.replace("\r\n", "\n").split("\n")
    var i = 0
    val para = StringBuilder()
    fun flush() {
        if (para.isNotBlank()) out += Block.Para(para.toString().trim())
        para.clear()
    }
    while (i < lines.size) {
        val line = lines[i]
        val t = line.trimStart()
        when {
            t.startsWith("```") || t.startsWith("~~~") -> {
                flush()
                val fence = t.take(3)
                val code = StringBuilder()
                i++
                while (i < lines.size && !lines[i].trimStart().startsWith(fence)) {
                    code.appendLine(lines[i]); i++
                }
                out += Block.Code(code.toString().trimEnd())
            }
            t.isEmpty() -> flush()
            Regex("^#{1,6} ").containsMatchIn(t) -> {
                flush(); val level = t.takeWhile { it == '#' }.length
                out += Block.Heading(level, t.drop(level).trim().trimEnd('#').trim())
            }
            Regex("^(-{3,}|\\*{3,}|_{3,})$").matches(t) -> { flush(); out += Block.Rule }
            t.startsWith(">") -> { flush(); out += Block.Quote(t.removePrefix(">").trim()) }
            Regex("^([-*+]|\\d+[.)]) ").containsMatchIn(t) -> {
                flush()
                val marker = t.substringBefore(' ')
                val shown = if (marker[0].isDigit()) marker else "•"
                val text = t.substringAfter(' ').let {
                    when {
                        it.startsWith("[ ] ") -> "☐ " + it.drop(4)
                        it.startsWith("[x] ", ignoreCase = true) -> "☑ " + it.drop(4)
                        else -> it
                    }
                }
                out += Block.Bullet(shown, text, (line.length - t.length) / 2)
            }
            t.startsWith("|") -> {
                flush()
                val rows = StringBuilder()
                while (i < lines.size && lines[i].trimStart().startsWith("|")) {
                    val r = lines[i].trim()
                    if (!Regex("^\\|[\\s:|-]+\\|$").matches(r)) rows.appendLine(r)
                    i++
                }
                out += Block.Code(rows.toString().trimEnd())
                continue
            }
            else -> para.append(if (para.isEmpty()) t else " $t")
        }
        i++
    }
    flush()
    return out
}

private val INLINE = Regex("""`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|\[([^\]]+)]\(([^)\s]+)\)|(?<![\w*])\*([^*\s][^*]*?)\*|(?<![\w_])_([^_\s][^_]*?)_|(https?://[^\s)]+)""")

fun inlineMarkdown(text: String, codeBg: Color, link: Color): AnnotatedString = buildAnnotatedString {
    var pos = 0
    for (m in INLINE.findAll(text)) {
        append(text.substring(pos, m.range.first))
        val g = m.groupValues
        when {
            g[1].isNotEmpty() -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBg)) { append(g[1]) }
            g[2].isNotEmpty() -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(g[2]) }
            g[3].isNotEmpty() -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(g[3]) }
            g[4].isNotEmpty() -> withLink(LinkAnnotation.Url(g[5], TextLinkStyles(SpanStyle(color = link, textDecoration = TextDecoration.Underline)))) { append(g[4]) }
            g[6].isNotEmpty() -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(g[6]) }
            g[7].isNotEmpty() -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(g[7]) }
            g[8].isNotEmpty() -> withLink(LinkAnnotation.Url(g[8], TextLinkStyles(SpanStyle(color = link)))) { append(g[8]) }
        }
        pos = m.range.last + 1
    }
    append(text.substring(pos))
}

/** Renders issue descriptions, comments and documents the way the web board's markdown view does. */
@Composable
fun Markdown(text: String, modifier: Modifier = Modifier) {
    val blocks = remember(text) { parseBlocks(text) }
    val scheme = MaterialTheme.colorScheme
    val type = MaterialTheme.typography
    val codeBg = scheme.surfaceVariant
    SelectionContainer(modifier) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for (b in blocks) when (b) {
                is Block.Heading -> Text(
                    inlineMarkdown(b.text, codeBg, scheme.tertiary),
                    style = when (b.level) { 1 -> type.titleLarge; 2 -> type.titleMedium; else -> type.titleSmall },
                    modifier = Modifier.padding(top = 4.dp),
                )
                is Block.Para -> Text(inlineMarkdown(b.text, codeBg, scheme.tertiary), style = type.bodyMedium)
                is Block.Bullet -> Row(Modifier.padding(start = (b.indent * 12).dp)) {
                    Text(b.marker, style = type.bodyMedium, modifier = Modifier.width(20.dp))
                    Text(inlineMarkdown(b.text, codeBg, scheme.tertiary), style = type.bodyMedium)
                }
                is Block.Quote -> Row {
                    Text("▍", color = scheme.outline)
                    Text(inlineMarkdown(b.text, codeBg, scheme.tertiary), style = type.bodyMedium, color = scheme.onSurfaceVariant)
                }
                is Block.Code -> Text(
                    b.text,
                    style = type.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    softWrap = false,
                    modifier = Modifier.fillMaxWidth()
                        .background(codeBg, MaterialTheme.shapes.small)
                        .horizontalScroll(rememberScrollState())
                        .padding(10.dp),
                )
                Block.Rule -> HorizontalDivider()
            }
        }
    }
}
