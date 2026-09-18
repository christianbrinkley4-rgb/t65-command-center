package com.t65.commandcenter.dialer

data class Lead(
    val id: String,
    val name: String?,
    val phone: String?,
    val phone2: String?,
    val status: String?,
    val stageBucket: String?,
    val nextFollowUpDate: String?,
    val lastContactDate: String?,
    val dialsCount: Int,
    val doNotCall: Boolean,
    val createdAt: String?,
)

data class Disposition(
    val key: String,
    val label: String,
    val status: String,
    val stage: String,
    val followUpDays: Int?,
    val closes: Boolean,
)

data class PhoneSession(
    val id: String,
    val currentLeadId: String?,
    val currentIndex: Int,
    val phoneCommand: Long,
    val phoneState: String,
    val queue: List<Lead>,
)

val DISPOSITIONS = listOf(
    Disposition("na", "No Answer", "No Answer", "Worked - Follow Up", 2, false),
    Disposition("vm", "Voicemail", "Voicemail Left", "Worked - Follow Up", 3, false),
    Disposition("int", "Talked - Interested", "Talked - Interested", "Worked - Follow Up", 3, false),
    Disposition("nr", "Talked - Not Ready", "Talked - Not Ready", "Worked - Follow Up", 30, false),
    Disposition("ni", "Not Interested", "Closed - Not Interested", "Closed", null, true),
    Disposition("bad", "Bad Number", "Closed - Bad Number", "Closed", null, true),
    Disposition("dnc", "DNC", "Closed - DNC", "Closed", null, true),
    Disposition("info", "Wrong Info", "Needs Info - Verify", "Needs Info", null, false),
)

fun isClosed(status: String?): Boolean {
    val value = status.orEmpty().trim().lowercase()
    return value.startsWith("closed") || listOf(
        "not interested", "wrong person", "wrong number", "closed lost",
        "already enrolled", "has advisor", "placed w/ another advisor", "deceased",
    ).any(value::contains)
}

fun canonicalPhone(phone: String?): String =
    phone.orEmpty().filter(Char::isDigit).takeLast(10)

fun dialablePhone(phone: String?): String? =
    canonicalPhone(phone).takeIf { it.length == 10 }

fun buildDialQueue(leads: List<Lead>, worked: Set<String>, today: String): List<Lead> {
    val dncPhones = leads.asSequence()
        .filter { it.doNotCall }
        .flatMap { sequenceOf(it.phone, it.phone2) }
        .map(::canonicalPhone)
        .filter { it.length == 10 }
        .toSet()
    return leads.asSequence()
        .filter {
            it.id !in worked &&
                !it.doNotCall &&
                canonicalPhone(it.phone) !in dncPhones &&
                canonicalPhone(it.phone2) !in dncPhones &&
                !isClosed(it.status)
        }
        .filter { it.stageBucket != "Needs Info" && (it.phone.orEmpty().isNotBlank() || it.phone2.orEmpty().isNotBlank()) }
        .filter { it.stageBucket != "Appointment Upcoming" }
        .sortedWith(compareByDescending<Lead> {
            when {
                it.nextFollowUpDate != null && it.nextFollowUpDate <= today -> 3
                it.stageBucket == "New Prospecting" && it.dialsCount == 0 -> 2
                else -> 1
            }
        }.thenBy { it.nextFollowUpDate ?: "9999-99-99" })
        .toList()
}

fun withinCallingHours(hour: Int): Boolean = hour in 8..20
