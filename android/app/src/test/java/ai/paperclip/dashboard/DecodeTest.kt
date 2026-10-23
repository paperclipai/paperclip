package ai.paperclip.dashboard

import ai.paperclip.dashboard.data.Approval
import ai.paperclip.dashboard.data.DashboardSummary
import ai.paperclip.dashboard.data.Issue
import ai.paperclip.dashboard.ui.approvalTitle
import ai.paperclip.dashboard.ui.humanize
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test

class DecodeTest {
    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true; explicitNulls = false }

    @Test
    fun decodesDashboardWithExtraFields() {
        val d = json.decodeFromString<DashboardSummary>(
            """{"companyId":"c1","agents":{"active":2,"running":1,"paused":0,"error":1},
               "tasks":{"open":5,"inProgress":2,"blocked":1,"done":9},
               "costs":{"monthSpendCents":1234,"monthBudgetCents":10000,"monthUtilizationPercent":12.34},
               "pendingApprovals":3,"budgets":{"activeIncidents":0,"pendingApprovals":1,"pausedAgents":0,"pausedProjects":0},
               "runActivity":[{"date":"2026-10-21","succeeded":4,"failed":1,"recovered":0,"other":0,"total":5,"failedByErrorCode":{"x":1}}],
               "somethingNew":true}""",
        )
        assertEquals(3, d.pendingApprovals)
        assertEquals(12.34, d.costs.monthUtilizationPercent, 0.001)
        assertEquals(5, d.runActivity.single().total)
    }

    @Test
    fun decodesIssueWithNullsAndUnknowns() {
        val i = json.decodeFromString<Issue>(
            """{"id":"i1","title":"Fix it","status":"in_progress","priority":"high","identifier":null,"description":null,"ancestors":[]}""",
        )
        assertEquals("in_progress", i.status)
        assertEquals(null, i.identifier)
    }

    @Test
    fun approvalTitleFallsBackToType() {
        val a = json.decodeFromString<Approval>("""{"id":"a","type":"hire_agent","payload":{"name":"CTO"}}""")
        assertEquals("CTO", approvalTitle(a))
        val b = json.decodeFromString<Approval>("""{"id":"b","type":"hire_agent","payload":{}}""")
        assertEquals("Hire agent", approvalTitle(b))
        assertEquals("In progress", humanize("in_progress"))
    }

    @Test
    fun parsesBoardClaimUrl() {
        assertEquals(
            "1923ab" to "6fbb10",
            parseBoardClaimUrl(" http://localhost:3100/board-claim/1923ab?code=6fbb10 "),
        )
        assertEquals(null, parseBoardClaimUrl("http://localhost:3100/board-claim/1923ab"))
    }

    @Test
    fun parsesPairingLink() {
        assertEquals(
            "http://100.101.102.103:3100" to "pcp_board_abc+/=",
            parsePairingLink("paperclip://connect?url=http%3A%2F%2F100.101.102.103%3A3100&key=pcp_board_abc%2B%2F%3D"),
        )
        assertEquals(null, parsePairingLink("paperclip://connect?url=javascript%3Aalert(1)&key=k"))
        assertEquals(null, parsePairingLink("https://example.com/connect?url=http%3A%2F%2Fx&key=k"))
        assertEquals(null, parsePairingLink("paperclip://connect?url=http%3A%2F%2Fx"))
        assertEquals(null, parsePairingLink("paperclip://connect?url=http%3A%2F%2F&key=k"))
    }

    @Test
    fun allowsPlainHttpOnlyForPrivateHosts() {
        listOf("localhost", "127.0.0.1", "10.0.2.2", "192.168.1.5", "172.20.0.1", "100.101.102.103", "box.tail1234.ts.net", "nas.local", "nas", "::1")
            .forEach { assertEquals(it, true, isPrivateHost(it)) }
        listOf("example.com", "8.8.8.8", "100.128.0.1", "172.32.0.1", "fdroid.org")
            .forEach { assertEquals(it, false, isPrivateHost(it)) }
    }
}
