package com.acme.billing;

import java.math.BigDecimal;

public class FeeCalculator {
    public BigDecimal feeFor(Order order) {
        return BigDecimal.ONE;
    }
}

abstract class AbstractPolicy {
    enum Mode { STRICT, LENIENT }
}
