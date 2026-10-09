package com.acme.billing;

import java.math.BigDecimal;
import java.util.List;

/**
 * Default policy: refunds at most the paid amount minus fees.
 */
@Component
public class DefaultRefundPolicy extends AbstractPolicy implements RefundPolicy {
    public static final BigDecimal MAX_FEE = new BigDecimal("5.00");
    private final FeeCalculator feeCalculator;
    protected int retries = 3;

    public DefaultRefundPolicy(FeeCalculator feeCalculator) {
        this.feeCalculator = feeCalculator;
    }

    /**
     * Computes the refund. Never exceeds the paid amount.
     * @param order the order
     */
    @Override
    public BigDecimal computeRefund(Order order, BigDecimal requested) {
        BigDecimal localFee = feeCalculator.feeFor(order);
        List<String> notes = List.of("x");
        return requested.min(order.getPaidAmount().subtract(localFee));
    }

    private static class Audit {
        void record(String what) {
            System.out.println(what);
        }
    }
}
