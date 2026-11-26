import { createMollieClient } from '@mollie/api-client';
import { config } from '../lib/config.js';

const LOCALES = { nl: 'nl_NL', en: 'en_US', ar: 'en_US' }; // Mollie has no Arabic checkout

const toValue = (cents) => (cents / 100).toFixed(2);
const toCents = (amount) => (amount ? Math.round(Number(amount.value) * 100) : 0);

export function mollieProvider() {
  if (!config.mollieKey) throw new Error('MOLLIE_API_KEY is not set');
  if (config.isProd && !config.mollieKey.startsWith('live_')) {
    console.warn('[payments] Running in production with a Mollie TEST key — no real money will be collected.');
  }
  const client = createMollieClient({ apiKey: config.mollieKey });
  // Mollie must reach the webhook over the public internet; it rejects localhost URLs.
  const publicApi = !/localhost|127\.0\.0\.1/.test(config.apiUrl);

  return {
    name: 'mollie',

    async createPayment({ order, redirectUrl }) {
      const payment = await client.payments.create({
        amount: { currency: order.currency, value: toValue(order.total) },
        description: `LORIM ${order.number}`,
        redirectUrl,
        webhookUrl: publicApi ? `${config.apiUrl}/api/payments/webhook` : undefined,
        locale: LOCALES[order.locale] || 'nl_NL',
        metadata: { orderId: order.id, orderNumber: order.number },
      });
      return { ref: payment.id, status: payment.status, checkoutUrl: payment.getCheckoutUrl() };
    },

    /** Source of truth: always ask Mollie, never trust the browser. */
    async getPayment(ref) {
      const p = await client.payments.get(ref);
      return {
        ref: p.id,
        status: p.status, // open | pending | authorized | paid | canceled | expired | failed
        method: p.method || null,
        amount: toCents(p.amount),
        refunded: toCents(p.amountRefunded),
        orderId: p.metadata?.orderId,
      };
    },

    async refund(ref, cents, currency = 'EUR') {
      const r = await client.paymentRefunds.create({ paymentId: ref, amount: { currency, value: toValue(cents) } });
      return { ref: r.id, status: r.status };
    },
  };
}
