package com.t65.commandcenter.dialer

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import android.view.Gravity
import android.widget.*
import androidx.activity.ComponentActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.time.LocalDate
import java.util.concurrent.Executors
import android.os.Handler
import android.os.Looper

class MainActivity : ComponentActivity() {
    private val executor = Executors.newSingleThreadExecutor()
    private val prefs by lazy { getSharedPreferences("t65_dialer", MODE_PRIVATE) }
    private var api: T65Api? = null
    private var queue = emptyList<Lead>()
    private var index = 0
    private var activeLead: Lead? = null
    private var sawCallState = false
    private var callStateRegistered = false
    private var dispositionVisible = false
    private var telephonyManager: TelephonyManager? = null
    private var telephonyCallback: TelephonyCallback? = null
    private var phoneStateListener: PhoneStateListener? = null
    private var phoneSession: PhoneSession? = null
    private var lastPhoneCommand = -1L
    private val sessionHandler = Handler(Looper.getMainLooper())
    private val sessionPoll = object : Runnable {
        override fun run() {
            pollSharedSession()
            sessionHandler.postDelayed(this, 1500)
        }
    }
    private lateinit var root: LinearLayout
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        showLogin()
    }

    private fun showLogin() {
        root = LinearLayout(this).vertical(16)
        val email = input("Email", prefs.getString("email", "") ?: "")
        val password = input("Password", "", true)
        val agent = input("Agent name", prefs.getString("agent", "Christian") ?: "Christian")
        val signIn = Button(this).apply { text = "Sign in" }
        root.addView(TextView(this).apply {
            text = "T65 SIM Dialer\nBackend is preconfigured. Enter your Command Center login."
            textSize = 20f
        })
        listOf(email, password, agent, signIn).forEach(root::addView)
        signIn.setOnClickListener {
            if (email.text.isNullOrBlank() || password.text.isNullOrBlank()) {
                toast("Email and password are required"); return@setOnClickListener
            }
            signIn.isEnabled = false
            executor.execute {
                try {
                    val client = T65Api()
                    client.signIn(email.text.toString(), password.text.toString())
                    prefs.edit().putString("email", email.text.toString()).putString("agent", agent.text.toString()).apply()
                    api = client
                    runOnUiThread { showDialer(agent.text.toString()) }
                } catch (e: Exception) {
                    runOnUiThread { signIn.isEnabled = true; toast(e.message ?: "Sign in failed") }
                }
            }
        }
        setContentView(root)
    }

    private fun showDialer(agent: String) {
        root = LinearLayout(this).vertical(12)
        status = TextView(this).apply { textSize = 16f }
        val settings = Button(this).apply { text = "Settings / sign out" }
        root.addView(TextView(this).apply { text = "T65 SIM Dialer"; textSize = 24f })
        root.addView(status)
        root.addView(TextView(this).apply {
            text = "Start and control the Dial Session on your computer. This phone will place each call."
        })
        root.addView(settings)
        settings.setOnClickListener { api?.signOut(); showLogin() }
        setContentView(root)
        status.text = "Waiting for the computer's Dial Session…"
        sessionHandler.post(sessionPoll)
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED) {
            registerCallState()
        }
    }

    private fun loadQueue(go: Button) {
        status.text = "Loading leads…"
        executor.execute {
            try {
                val leads = api!!.loadLeads()
                queue = buildDialQueue(leads, emptySet(), LocalDate.now().toString())
                runOnUiThread { status.text = "${queue.size} leads ready"; go.isEnabled = queue.isNotEmpty() }
            } catch (e: Exception) {
                runOnUiThread { status.text = e.message ?: "Could not load queue" }
            }

        }
    }

    private fun pollSharedSession() {
        executor.execute {
            try {
                val session = api?.activeDialSession()
                runOnUiThread {
                    phoneSession = session
                    if (session == null) {
                        status.text = "Waiting for the computer's Dial Session…"
                        return@runOnUiThread
                    }
                    val lead = session.queue.getOrNull(session.currentIndex)
                    status.text = if (lead == null) "Computer session complete" else
                        "Computer session: ${lead.name ?: "lead"} (${session.currentIndex + 1}/${session.queue.size})"
                    if (lead != null && session.phoneCommand != lastPhoneCommand && session.phoneState == "idle") {
                        lastPhoneCommand = session.phoneCommand
                        startPhoneCall(session, lead)
                    }
                }
            } catch (e: Exception) {
                runOnUiThread { status.text = "Phone link unavailable: ${e.message ?: "backend error"}" }
            }
        }
    }

    private fun startPhoneCall(session: PhoneSession, lead: Lead) {
        val phone = lead.phone?.takeIf(String::isNotBlank) ?: lead.phone2
        if (phone.isNullOrBlank()) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
            activeLead = lead
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CALL_PHONE, Manifest.permission.READ_PHONE_STATE), CALL_PERMISSION)
            return
        }
        activeLead = lead
        sawCallState = false
        executor.execute { runCatching { api?.updatePhoneState(session.id, "dialing") } }
        try {
            startActivity(Intent(Intent.ACTION_CALL, Uri.parse("tel:${Uri.encode(phone)}")))
        } catch (e: Exception) {
            executor.execute { runCatching { api?.updatePhoneState(session.id, "error") } }
            status.text = "Could not open the Phone app: ${e.message ?: "call unavailable"}"
        }
    }

    private fun startNextCall(agent: String) {
        if (activeLead != null || dispositionVisible) return
        if (!withinCallingHours(java.time.LocalTime.now().hour)) {
            status.text = "Calling is paused outside 8:00 AM–9:00 PM local time"
            return
        }
        val lead = queue.getOrNull(index) ?: run { status.text = "Queue complete"; return }
        val phone = lead.phone?.takeIf(String::isNotBlank) ?: lead.phone2
        if (phone.isNullOrBlank()) { index++; startNextCall(agent); return }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
            activeLead = lead
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.CALL_PHONE, Manifest.permission.READ_PHONE_STATE),
                CALL_PERMISSION,
            )
            return
        }
        activeLead = lead
        sawCallState = false
        status.text = "Calling ${lead.name ?: "lead"} (${index + 1}/${queue.size})"
        try {
            startActivity(Intent(Intent.ACTION_CALL, Uri.parse("tel:${Uri.encode(phone)}")))
        } catch (e: Exception) {
            activeLead = null
            status.text = "Could not open the Phone app: ${e.message ?: "call unavailable"}"
        }
    }

    private fun registerCallState() {
        if (callStateRegistered) return
        val manager = getSystemService(TELEPHONY_SERVICE) as TelephonyManager
        telephonyManager = manager
        callStateRegistered = true
        if (android.os.Build.VERSION.SDK_INT >= 31) {
            val callback = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
                override fun onCallStateChanged(state: Int) = onCallState(state)
            }
            telephonyCallback = callback
            manager.registerTelephonyCallback(mainExecutor, callback)
        } else {
            @Suppress("DEPRECATION")
            val listener = object : PhoneStateListener() {
                override fun onCallStateChanged(state: Int, phoneNumber: String?) = onCallState(state)
            }
            phoneStateListener = listener
            manager.listen(listener, PhoneStateListener.LISTEN_CALL_STATE)
        }
    }

    private fun onCallState(state: Int) {
        if (state == TelephonyManager.CALL_STATE_OFFHOOK || state == TelephonyManager.CALL_STATE_RINGING) sawCallState = true
        if (state == TelephonyManager.CALL_STATE_IDLE && sawCallState && activeLead != null) {
            sawCallState = false
            val session = phoneSession
            activeLead = null
            if (session != null) executor.execute { runCatching { api?.updatePhoneState(session.id, "ended") } }
            runOnUiThread { status.text = "Call ended — disposition it on the computer." }
        }
    }

    private fun showDispositionDialog(agent: String) {
        val lead = activeLead ?: return
        if (dispositionVisible) return
        dispositionVisible = true
        val note = EditText(this).apply { hint = "What did they say?"; minLines = 2 }
        val container = LinearLayout(this).vertical(8)
        container.addView(note)
        val dialog = android.app.AlertDialog.Builder(this).setTitle("Disposition: ${lead.name ?: "lead"}").setView(container).create()
        DISPOSITIONS.forEach { disposition ->
            container.addView(Button(this).apply {
                text = disposition.label
                setOnClickListener {
                    isEnabled = false
                    executor.execute {
                        try {
                            api!!.saveDisposition(lead, disposition, note.text.toString(), agent)
                            index++
                            runOnUiThread {
                                dialog.dismiss()
                                dispositionVisible = false
                                activeLead = null
                                startNextCall(agent)
                            }
                        } catch (e: Exception) {
                            runOnUiThread { isEnabled = true; toast(e.message ?: "Could not save disposition") }
                        }
                    }
                }
            })
        }
        dialog.setOnCancelListener { dispositionVisible = false }
        dialog.show()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, results)
        if (requestCode == CALL_PERMISSION && results.all { it == PackageManager.PERMISSION_GRANTED }) {
            registerCallState()
            val session = phoneSession
            val lead = session?.queue?.getOrNull(session.currentIndex)
            if (session != null && lead != null) {
                startPhoneCall(session, lead)
            } else {
                startNextCall(prefs.getString("agent", "Christian") ?: "Christian")
            }
        } else if (requestCode == CALL_PERMISSION) toast("Phone permission is required to place SIM calls")
    }

    override fun onDestroy() {
        sessionHandler.removeCallbacks(sessionPoll)
        telephonyCallback?.let { callback ->
            if (android.os.Build.VERSION.SDK_INT >= 31) {
                telephonyManager?.unregisterTelephonyCallback(callback)
            }
        }
        @Suppress("DEPRECATION")
        phoneStateListener?.let { listener ->
            if (android.os.Build.VERSION.SDK_INT < 31) {
                telephonyManager?.listen(listener, PhoneStateListener.LISTEN_NONE)
            }
        }
        executor.shutdownNow()
        super.onDestroy()
    }

    private fun input(hint: String, value: String, password: Boolean = false) = EditText(this).apply {
        this.hint = hint; setText(value); setSingleLine()
        if (password) inputType = 0x81
    }

    private fun LinearLayout.vertical(spacing: Int) = apply {
        orientation = LinearLayout.VERTICAL; setPadding(32, 32, 32, 32); gravity = Gravity.TOP
    }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    companion object { private const val CALL_PERMISSION = 1001 }
}
