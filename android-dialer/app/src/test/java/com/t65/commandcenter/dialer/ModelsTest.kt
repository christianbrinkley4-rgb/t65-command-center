package com.t65.commandcenter.dialer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ModelsTest {
    @Test
    fun queuePutsDueLeadsBeforeNewLeadsAndExcludesClosedDnc() {
        val leads = listOf(
            Lead("new", "New", "1", null, "New", "New Prospecting", null, null, 0, false, null),
            Lead("due", "Due", "2", null, "Working", "Worked - Follow Up", "2026-09-17", null, 1, false, null),
            Lead("closed", "Closed", "3", null, "Closed - Not Interested", "Closed", null, null, 1, false, null),
            Lead("dnc", "DNC", "2025550100", null, "Working", "Worked", null, null, 1, true, null),
            Lead("twin", "Twin", "2025550100", null, "Working", "Worked", null, null, 1, false, null),
        )
        assertEquals(listOf("due", "new"), buildDialQueue(leads, emptySet(), "2026-09-17").map(Lead::id))
    }

    @Test
    fun authenticatedRequestsUseBearerAccessToken() {
        assertEquals("Bearer session-token", T65Api.authorizationHeader("session-token", true))
        assertNull(T65Api.authorizationHeader(null, true))
        assertNull(T65Api.authorizationHeader("session-token", false))
    }

    @Test
    fun callsAreAllowedOnlyDuringConsumerCallingWindow() {
        assertEquals(false, withinCallingHours(7))
        assertEquals(true, withinCallingHours(8))
        assertEquals(true, withinCallingHours(20))
        assertEquals(false, withinCallingHours(21))
    }

}
