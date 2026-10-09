import { roundCents, formatMoney as fmt } from './money';
import * as path from 'node:path';
import type { Repo } from '../repo';

export interface OrderLine {
  sku: string;
  qty: number;
}

export type OrderId = string;

export enum OrderStatus {
  Open,
  Closed,
}

/**
 * Places and prices orders.
 */
export class OrderService extends BaseService implements Disposable {
  private readonly lines: OrderLine[] = [];
  static instances = 0;

  constructor(private repo: Repo) {
    super();
  }

  /** Total price of the order, rounded. */
  async total(id: OrderId): Promise<number> {
    const sum = this.lines.reduce((acc, l) => acc + l.qty, 0);
    return roundCents(sum);
  }

  describe = (id: OrderId): string => {
    return fmt(this.computeTotalSync(id));
  };

  private computeTotalSync(id: OrderId): number {
    return 0;
  }
}

export const placeOrder = async (svc: OrderService, id: OrderId) => {
  const t = await svc.total(id);
  return new Receipt(t);
};

export namespace Orders {
  export function make(): OrderService {
    return new OrderService(null as any);
  }
}
