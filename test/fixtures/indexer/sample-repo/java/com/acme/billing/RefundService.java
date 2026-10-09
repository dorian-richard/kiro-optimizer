package com.acme.billing;

import java.math.BigDecimal;

public class RefundService {
    private final RefundPolicy policy;

    public RefundService() {
        this.policy = new DefaultRefundPolicy(new FeeCalculator());
    }

    // Refunds an order, applying the configured policy.
    public BigDecimal refund(Order order, BigDecimal amount) {
        if (!policy.isEligible(order)) {
            return BigDecimal.ZERO;
        }
        return policy.computeRefund(order, amount);
    }
}
