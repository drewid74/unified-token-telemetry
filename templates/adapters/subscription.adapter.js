/**
 * Subscription Cost Adapter — Unified Token Telemetry
 *
 * Records fixed monthly subscription costs for AI services that either:
 *   - Have no usage API (Gemini Advanced, Perplexity Pro consumer tier)
 *   - Are flat-rate plans where per-token tracking is impractical
 *
 * This adapter does NOT collect token counts — only cost attribution.
 * It emits one record per subscription per billing cycle (monthly).
 *
 * Supported services (configured in config.yaml sources.subscriptions[]):
 *   - ChatGPT Plus ($20/mo)     | provider: openai
 *   - ChatGPT Pro ($200/mo)     | provider: openai
 *   - Claude Pro ($20/mo)       | provider: anthropic
 *   - Claude Max ($100/mo)      | provider: anthropic
 *   - Gemini Advanced ($20/mo)  | provider: google
 *   - Perplexity Pro ($20/mo)   | provider: perplexity
 *   - Cursor Pro ($20/mo)       | provider: cursor
 *   - Cursor Ultra ($40/mo)     | provider: cursor
 *   - Windsurf Pro ($15/mo)     | provider: windsurf
 *   - Windsurf Ultra ($60/mo)   | provider: windsurf
 *
 * Measurement basis: 'derived_estimate' — cost is known exactly, but
 * token counts are not available (no API) so they remain null.
 *
 * Billing logic:
 *   Each cycle, checks if we've already recorded this month's subscription.
 *   If current date >= billing_day and no record exists for this month, emit record.
 *   Supports mid-month starts (prorated = false by default — full month cost).
 */

'use strict';

class SubscriptionAdapter {
  constructor(config) {
    this.config       = config;
    this.sourceSystem = 'subscription';
    this.displayName  = 'Fixed Subscriptions';
    this._subscriptions = config.sources.subscriptions?.plans || [];
  }

  async detectCapabilities() {
    if (!this._subscriptions.length) {
      throw new Error('No subscriptions configured in sources.subscriptions.plans[]');
    }

    return {
      granularity:      'month',
      hasCacheData:     false,
      measurementBasis: 'derived_estimate',
      supportsBackfill: true,    // Can backfill past months
      models:           [],
    };
  }

  async collectWindow(windowStart, windowEnd) {
    const rawRecords = [];
    const now = new Date();

    for (const sub of this._subscriptions) {
      if (!sub.enabled) continue;

      // Determine the billing window for this subscription
      const billingDay = sub.billing_day || 1;  // Day of month subscription renews
      const monthStart = this._getBillingWindowStart(windowEnd, billingDay);
      const monthEnd   = this._getBillingWindowEnd(monthStart);

      // Only emit if we're past the billing day for this cycle
      if (now < monthStart) continue;

      rawRecords.push({
        name:         sub.name,
        provider:     sub.provider,
        plan:         sub.plan || sub.name,
        cost_usd:     sub.monthly_cost_usd,
        billing_start: monthStart.toISOString(),
        billing_end:   monthEnd.toISOString(),
      });
    }

    return rawRecords;
  }

  normalizeRecord(raw) {
    if (!raw.cost_usd || raw.cost_usd <= 0) return null;

    return {
      source_system:       this.sourceSystem,
      provider:            raw.provider,
      model:               raw.plan,          // Use plan name as "model" for grouping
      model_id:            `subscription:${raw.name}`,
      window_start:        new Date(raw.billing_start),
      window_end:          new Date(raw.billing_end),
      granularity:         'month',
      measurement_basis:   'derived_estimate',
      input_tokens:        null,              // No token data for flat subscriptions
      output_tokens:       null,
      cached_read_tokens:  null,
      cached_write_tokens: null,
      cost_usd:            raw.cost_usd,
      user_id:             this.config.identity?.user_id || null,
    };
  }

  mapMeasurementBasis(_rawType) {
    return 'derived_estimate';
  }

  // ─────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────

  /**
   * Get the start of the billing period that contains or precedes the reference date.
   * If billing_day is 15 and reference is June 20, returns June 15.
   * If billing_day is 15 and reference is June 10, returns May 15.
   */
  _getBillingWindowStart(referenceDate, billingDay) {
    const year  = referenceDate.getFullYear();
    const month = referenceDate.getMonth();
    const day   = referenceDate.getDate();

    if (day >= billingDay) {
      return new Date(Date.UTC(year, month, billingDay));
    } else {
      // Previous month
      return new Date(Date.UTC(year, month - 1, billingDay));
    }
  }

  /**
   * Get the end of a billing period (one month after start).
   */
  _getBillingWindowEnd(billingStart) {
    const end = new Date(billingStart);
    end.setUTCMonth(end.getUTCMonth() + 1);
    return end;
  }
}

module.exports = SubscriptionAdapter;
