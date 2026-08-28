import { defineChecker } from '../checker-registry';
import { z } from 'zod';
import { logger } from '../../../utils/logger';

interface TokenRouterWalletData {
  topUpBalance: number;
  toppedUpSpent: number;
  voucherEfficientAmount: number;
  voucherSpent: number;
}

interface TokenRouterWalletResponse {
  data: TokenRouterWalletData | null;
  message: string;
  success: boolean;
}

interface TokenRouterSubscriptionResponse {
  has_payment_method: boolean;
  system_hard_limit_usd: number;
}

interface TokenRouterUsageResponse {
  object: string;
  total_usage: number;
}

function firstOfMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export default defineChecker({
  type: 'tokenrouter',
  displayName: 'TokenRouter',
  optionsSchema: z.object({
    apiKey: z.string().optional(),
    managementKey: z.string().optional(),
    endpoint: z.string().url().optional(),
  }),
  async check(ctx) {
    // Management key unlocks the wallet endpoint; otherwise fall back to the
    // billing endpoints with a plain API key.
    const managementKey = ctx.getOption<string | undefined>('managementKey', undefined);
    const apiKey = ctx.getOption<string | undefined>('apiKey', undefined);
    const endpoint = ctx.getOption<string | undefined>('endpoint', undefined);

    if (managementKey) {
      const walletUrl =
        endpoint ?? 'https://api.tokenrouter.com/api/management/self/wallet';
      logger.silly(`Calling ${walletUrl}`);
      const response = await fetch(walletUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${managementKey}`,
          Accept: 'application/json',
        },
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

      const body: TokenRouterWalletResponse = await response.json();

      if (!body.success) {
        throw new Error(`TokenRouter API returned success=false: ${body.message || 'unknown error'}`);
      }

      if (!body.data) {
        throw new Error('TokenRouter wallet response missing data');
      }

      const { topUpBalance, toppedUpSpent, voucherEfficientAmount, voucherSpent } = body.data;
      const totalBalance = topUpBalance + voucherEfficientAmount;

      return [
        ctx.balance({
          key: 'balance',
          label: 'Total balance',
          unit: 'usd',
          remaining: totalBalance,
        }),
        ctx.balance({
          key: 'topup',
          label: 'Top Up',
          unit: 'usd',
          used: toppedUpSpent,
          remaining: topUpBalance,
        }),
        ctx.balance({
          key: 'bonus',
          label: 'Bonus',
          unit: 'usd',
          used: voucherSpent,
          remaining: voucherEfficientAmount,
        }),
      ];
    }

    if (!apiKey) {
      throw new Error("TokenRouter requires either 'managementKey' or 'apiKey'");
    }

    const baseUrl = endpoint ?? 'https://api.tokenrouter.com';

    // Step 1: Get subscription info (hard limit)
    const subscriptionUrl = `${baseUrl}/v1/dashboard/billing/subscription`;
    logger.silly(`Calling ${subscriptionUrl}`);
    const subResponse = await fetch(subscriptionUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });

    if (!subResponse.ok)
      throw new Error(`Subscription HTTP ${subResponse.status}: ${subResponse.statusText}`);

    const subData: TokenRouterSubscriptionResponse = await subResponse.json();

    if (typeof subData.system_hard_limit_usd !== 'number') {
      throw new Error('Invalid subscription response: missing system_hard_limit_usd');
    }

    const hardLimitUsd = subData.system_hard_limit_usd;

    // Step 2: Get usage for current month
    const usageUrl = `${baseUrl}/v1/dashboard/billing/usage?start_date=${firstOfMonth()}&end_date=${today()}`;
    logger.silly(`Calling ${usageUrl}`);
    const usageResponse = await fetch(usageUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });

    if (!usageResponse.ok)
      throw new Error(`Usage HTTP ${usageResponse.status}: ${usageResponse.statusText}`);

    const usageData: TokenRouterUsageResponse = await usageResponse.json();

    if (typeof usageData.total_usage !== 'number') {
      throw new Error('Invalid usage response: missing total_usage');
    }

    // total_usage is in 0.01 USD units (e.g. 1234.5 = $12.345)
    const usedUsd = usageData.total_usage / 100;
    const remainingUsd = hardLimitUsd - usedUsd;

    return [
      ctx.balance({
        key: 'account_balance',
        label: 'TokenRouter account balance',
        unit: 'usd',
        limit: hardLimitUsd,
        used: usedUsd,
        remaining: remainingUsd,
      }),
    ];
  },
});
