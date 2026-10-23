package ai.paperclip.dashboard

import ai.paperclip.dashboard.ui.buildTranscript
import org.junit.Assert.assertEquals
import org.junit.Test

class TranscriptTest {
    @Test
    fun mergesTextDeltasAcrossSplitChunksAndDropsUsage() {
        val t = buildTranscript(
            listOf(
                "stdout" to """{"type":"acpx.text_delta","text":"Hello ","tag":"agent_message_chunk"}""" + "\n" + """{"type":"acpx.text_de""",
                "stdout" to """lta","text":"world","tag":"agent_message_chunk"}""" + "\n",
                "stdout" to """{"type":"acpx.status","text":"usage updated","tag":"usage_update"}""" + "\n",
                "stdout" to """{"type":"acpx.tool_call","name":"bash","toolCallId":"t1","status":"pending","text":"ls"}""" + "\n",
                "stdout" to """{"type":"acpx.tool_call","name":"bash","toolCallId":"t1","status":"completed"}""" + "\n",
                "stdout" to """{"type":"acpx.result","summary":"completed","stopReason":"end_turn"}""" + "\n",
                "stderr" to "boom\n",
            )
        )
        assertEquals(listOf("message", "tool", "result", "stderr"), t.map { it.kind })
        assertEquals("Hello world", t[0].text)
        assertEquals("bash · completed#t1", t[1].title)
        assertEquals("ls", t[1].text)
    }
}
