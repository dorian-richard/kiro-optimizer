package com.acme.notify

import com.acme.billing.RefundService

/**
 * Sends notifications to customers.
 */
class Notifier(private val sender: EmailSender) : BaseNotifier(), Closeable {
    val maxRetries: Int = 3

    /** Notifies about a refund. */
    fun notifyRefund(orderId: String, amount: Double): Boolean {
        val msg = format(orderId, amount)
        return sender.send(msg)
    }

    private fun format(orderId: String, amount: Double): String = "$orderId:$amount"

    companion object {
        const val DEFAULT_CHANNEL = "email"
    }
}

interface EmailSender {
    fun send(msg: String): Boolean
}

object NotifierRegistry {
    fun register(n: Notifier) {}
}

fun topLevelHelper(x: Int): Int = x + 1
