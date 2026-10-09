package com.acme.billing;

import java.math.BigDecimal;

public record Order(String id, BigDecimal paid) {
    public BigDecimal getPaidAmount() { return paid; }
}
