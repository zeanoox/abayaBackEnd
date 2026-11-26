// LOCAL DEVELOPMENT ONLY: a fake payment provider so the full checkout can be tested without a Mollie account.
// It behaves like Mollie: the backend still asks the "provider" for the real status before marking anything paid.
import crypto from 'node:crypto';
import { config } from '../lib/config.js';

const payments = new Map(); // ref -> { status, amount, orderId, redirectUrl, method }

export function mockProvider() {
  if (config.isProd) throw new Error('The mock payment provider cannot be used in production');
  return {
    name: 'mock',
    async createPayment({ order, redirectUrl }) {
      const ref = `mock_${crypto.randomBytes(8).toString('hex')}`;
      payments.set(ref, { status: 'open', amount: order.total, orderId: order.id, redirectUrl, method: null });
      return { ref, status: 'open', checkoutUrl: `${config.apiUrl}/api/payments/mock/${ref}` };
    },
    async getPayment(ref) {
      const p = payments.get(ref);
      if (!p) throw Object.assign(new Error('Unknown mock payment'), { statusCode: 404 });
      return { ref, status: p.status, method: p.method, amount: p.amount, refunded: p.refunded || 0, orderId: p.orderId };
    },
    async refund(ref, cents) {
      const p = payments.get(ref);
      p.refunded = (p.refunded || 0) + cents;
      return { ref: `re_${ref}`, status: 'pending' };
    },
    // Test helpers used by the mock checkout page.
    _get: (ref) => payments.get(ref),
    _set(ref, status, method = 'ideal') {
      const p = payments.get(ref);
      if (p && p.status === 'open') Object.assign(p, { status, method });
      return p;
    },
  };
}
