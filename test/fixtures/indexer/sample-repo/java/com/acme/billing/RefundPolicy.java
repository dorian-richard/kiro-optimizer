package com.acme.billing;

import java.math.BigDecimal;

/**
 * Decides how much of an order can be refunded. Implementations must be stateless.
 */
public interface RefundPolicy {
    /** Computes the refundable amount for an order. */
    BigDecimal computeRefund(Order order, BigDecimal requested);

    default boolean isEligible(Order order) {
        return order != null;
    }
}
