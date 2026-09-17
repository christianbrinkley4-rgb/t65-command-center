package com.t65.commandcenter.dialer

import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalDate

class T65Api(
    private val baseUrl: String = DEFAULT_SUPABASE_URL,
    private val anonKey: String = DEFAULT_SUPABASE_ANON_KEY,
    private var accessToken: String? = null,
) {
    fun isAuthenticated() = !accessToken.isNullOrBlank()

    fun signIn(email: String, password: String) {
        val body = JSONObject().put("email", email).put("password", password)
        val json = request("POST", "/auth/v1/token?grant_type=password", body, authenticated = false)
        accessToken = json.getString("access_token")
    }

    fun signOut() {
        accessToken = null
    }

    fun activeDialSession(): PhoneSession? {
        val rows = request(
            "GET",
            "/rest/v1/dial_sessions?status=eq.active&order=updated_at.desc&limit=1",
        ).getJSONArray("rows")
        if (rows.length() == 0) return null
        val row = rows.getJSONObject(0)
        val queueJson = row.optJSONArray("queue") ?: JSONArray()
        val queue = (0 until queueJson.length()).map { i ->
            val item = queueJson.getJSONObject(i)
            Lead(
                item.getString("id"),
                item.optString("name").takeUnless { it.isEmpty() },
                item.optString("phone").takeUnless { it.isEmpty() },
                item.optString("phone2").takeUnless { it.isEmpty() },
                null, null, null, null, 0, false, null,
            )
        }
        return PhoneSession(
            row.getString("id"),
            row.optString("current_lead_id").takeUnless { it.isEmpty() },
            row.optInt("current_index", 0),
            row.optLong("phone_command", 0),
            row.optString("phone_state", "idle"),
            queue,
        )
    }

    fun updatePhoneState(sessionId: String, state: String) {
        request(
            "PATCH",
            "/rest/v1/dial_sessions?id=eq.${Uri.encode(sessionId)}",
            JSONObject().put("phone_state", state).put("phone_event_at", java.time.Instant.now().toString()),
        )
    }

    fun loadLeads(): List<Lead> {
        val columns = "id,name,phone,phone2,status,stage_bucket,next_follow_up_date,last_contact_date,dials_count,do_not_call,created_at"
        val leads = mutableListOf<Lead>()
        var offset = 0
        while (true) {
            val rows = request(
                "GET",
                "/rest/v1/leads?select=${Uri.encode(columns)}&limit=$PAGE_SIZE&offset=$offset",
            ).getJSONArray("rows")
            for (i in 0 until rows.length()) {
                val row = rows.getJSONObject(i)
                leads += Lead(
                    row.getString("id"),
                    row.optString("name").takeUnless { it.isEmpty() },
                    row.optString("phone").takeUnless { it.isEmpty() },
                    row.optString("phone2").takeUnless { it.isEmpty() },
                    row.optString("status").takeUnless { it.isEmpty() },
                    row.optString("stage_bucket").takeUnless { it.isEmpty() },
                    row.optString("next_follow_up_date").takeUnless { it.isEmpty() },
                    row.optString("last_contact_date").takeUnless { it.isEmpty() },
                    row.optInt("dials_count", 0),
                    row.optBoolean("do_not_call", false),
                    row.optString("created_at").takeUnless { it.isEmpty() },
                )
            }
            if (rows.length() < PAGE_SIZE) return leads
            offset += PAGE_SIZE
        }
    }

    fun saveDisposition(lead: Lead, disposition: Disposition, note: String, agent: String) {
        val today = LocalDate.now().toString()
        val followUp = disposition.followUpDays?.let { LocalDate.now().plusDays(it.toLong()).toString() }
        val patch = JSONObject()
            .put("status", disposition.status)
            .put("stage_bucket", disposition.stage)
            .put("next_follow_up_date", followUp ?: JSONObject.NULL)
            .put("last_contact_date", today)
            .put("dials_count", lead.dialsCount + 1)
            .put("updated_at", java.time.Instant.now().toString())
        if (disposition.key == "dnc") patch.put("do_not_call", true)
        if (note.isNotBlank()) {
            patch.put("raw_notes", "[$today call · $agent] ${note.trim()}")
            patch.put("next_follow_up_note", note.trim())
        }
        request("PATCH", "/rest/v1/leads?id=eq.${Uri.encode(lead.id)}", patch)
        val activity = JSONObject()
            .put("lead_id", lead.id)
            .put("activity_type", "Call")
            .put("outcome", disposition.status)
            .put("notes", note.trim().ifEmpty { JSONObject.NULL })
            .put("logged_by", agent)
            .put("activity_date", java.time.Instant.now().toString())
        request("POST", "/rest/v1/activity_log", activity)
    }

    private fun request(method: String, path: String, body: JSONObject? = null, authenticated: Boolean = true): JSONObject {
        val connection = (URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 20_000
            setRequestProperty("apikey", anonKey)
            setRequestProperty("Accept", "application/json")
            authorizationHeader(accessToken, authenticated)?.let {
                setRequestProperty("Authorization", it)
            }
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Prefer", "return=minimal")
            }
        }
        if (body != null) {
            val payload = body.toString().toByteArray(Charsets.UTF_8)
            connection.outputStream.use { output -> output.write(payload) }
        }
        val code = connection.responseCode
        val stream = if (code in 200..299) connection.inputStream else connection.errorStream
        val text = stream?.use { BufferedReader(InputStreamReader(it)).readText() }.orEmpty()
        if (code !in 200..299) error("Backend request failed ($code): ${parseError(text)}")
        return wrapResponse(text)
    }

    private fun parseError(text: String): String = runCatching { JSONObject(text).optString("message") }
        .getOrNull()?.takeUnless { it.isNullOrBlank() } ?: text.take(200)

    companion object {
        private const val DEFAULT_SUPABASE_URL = "https://lyvhrxiukmlvrznkrtkv.supabase.co"
        private const val DEFAULT_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx5dmhyeGl1a21sdnJ6bmtydGt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NTI2NjEsImV4cCI6MjEwMDEyODY2MX0.1KunPtVOtKaO1vHizq5FRQSlVzme_HpQMGQ9WX-rfpE"
        private const val PAGE_SIZE = 1000

        internal fun authorizationHeader(accessToken: String?, authenticated: Boolean): String? =
            if (authenticated) accessToken?.takeUnless { it.isBlank() }?.let { "Bearer $it" } else null

        internal fun wrapResponse(text: String): JSONObject {
            if (text.isBlank()) return JSONObject()
            return if (text.trimStart().startsWith("[")) {
                JSONObject().put("rows", JSONArray(text))
            } else {
                JSONObject(text)
            }
        }
    }

}
