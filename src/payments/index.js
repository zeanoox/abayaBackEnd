import { config } from '../lib/config.js';
import { mollieProvider } from './mollie.js';
import { mockProvider } from './mock.js';

let provider;

export function payments() {
  if (!provider) {
    provider = config.paymentProvider === 'mock' ? mockProvider() : mollieProvider();
    console.log(`[payments] provider: ${provider.name}`);
  }
  return provider;
}

// Provider status -> our payment_status enum.
export const PAYMENT_STATUS = {
  open: 'OPEN', pending: 'PENDING', authorized: 'AUTHORIZED', paid: 'PAID',
  failed: 'FAILED', canceled: 'CANCELED', expired: 'EXPIRED',
};
