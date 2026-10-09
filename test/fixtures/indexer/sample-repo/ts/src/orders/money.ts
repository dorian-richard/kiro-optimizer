/** Money helpers shared by the order module. */

export const CURRENCY = 'EUR';

/**
 * Rounds an amount to cents. Uses banker's rounding.
 */
export function roundCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}

export const formatMoney = (amount: number, currency: string = CURRENCY): string => {
  const rounded = roundCents(amount);
  return `${rounded} ${currency}`;
};

const internalHelper = function (x: number) {
  return x * 2;
};
