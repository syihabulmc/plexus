import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMeterContext } from '../../checker-registry';
import checkerDef from '../naga-checker';

const makeCtx = (options: Record<string, unknown> = {}) =>
  createMeterContext('tokenrouter-test', 'tokenrouter', options);

const walletResponse = {
  data: {
    topUpBalance: 100,
    toppedUpSpent: 10,
    voucherEfficientAmount: 50,
    voucherSpent: 5,
  },
  message: 'ok',
  success: true,
};

const subscriptionResponse = {
  has_payment_method: true,
  system_hard_limit_usd: 1000,
};

const usageResponse = { object: 'list', total_usage: 1234.5 };

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('tokenrouter checker', () => {
  const capturedUrls: string[] = [];
  let capturedAuths: Array<string | undefined> = [];

  const setFetchMock = (responses: Response[]): void => {
    capturedUrls.length = 0;
    capturedAuths = [];
    let i = 0;
    global.fetch = vi.fn(async (input: unknown, init: unknown) => {
      capturedUrls.push(String(input as string));
      capturedAuths.push(
        new Headers((init as RequestInit | undefined)?.headers).get('Authorization') ?? undefined
      );
      const idx = Math.min(i, responses.length - 1);
      i += 1;
      return responses[idx];
    }) as unknown as typeof fetch;
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    capturedAuths = [];
  });

  it('uses the wallet endpoint with managementKey when both keys are present', async () => {
    setFetchMock([jsonResponse(walletResponse)]);
    const meters = await checkerDef.check(
      makeCtx({ apiKey: 'sk-billing', managementKey: 'sk-mgmt' })
    );
    expect(capturedUrls[0]).toBe('https://api.tokenrouter.com/api/management/self/wallet');
    expect(capturedAuths[0]).toBe('Bearer sk-mgmt');
    expect(meters).toHaveLength(3);
    expect(meters[0]).toMatchObject({
      key: 'balance',
      label: 'Total balance',
      kind: 'balance',
      unit: 'usd',
      remaining: 150,
    });
    expect(meters[1]).toMatchObject({
      key: 'topup',
      used: 10,
      remaining: 100,
    });
    expect(meters[2]).toMatchObject({
      key: 'bonus',
      used: 5,
      remaining: 50,
    });
  });

  it('throws on wallet success=false', async () => {
    setFetchMock([jsonResponse({ data: null, message: 'nope', success: false })]);
    await expect(checkerDef.check(makeCtx({ managementKey: 'sk-mgmt' }))).rejects.toThrow(
      /success=false/
    );
  });

  it('calls subscription then usage with apiKey when managementKey is missing', async () => {
    setFetchMock([jsonResponse(subscriptionResponse), jsonResponse(usageResponse)]);
    const meters = await checkerDef.check(makeCtx({ apiKey: 'sk-billing' }));
    expect(capturedUrls).toHaveLength(2);
    expect(capturedUrls[0]).toBe(
      'https://api.tokenrouter.com/v1/dashboard/billing/subscription'
    );
    expect(capturedUrls[1]).toMatch(
      /\/v1\/dashboard\/billing\/usage\?start_date=\d{4}-\d{2}-01&end_date=\d{4}-\d{2}-\d{2}/
    );
    expect(capturedAuths[0]).toBe('Bearer sk-billing');
    expect(capturedAuths[1]).toBe('Bearer sk-billing');
    expect(meters).toHaveLength(1);
    expect(meters[0]).toMatchObject({
      key: 'account_balance',
      label: 'TokenRouter account balance',
      kind: 'balance',
      limit: 1000,
      used: 12.345,
      remaining: 987.655,
    });
  });

  it('throws when neither managementKey nor apiKey is present', async () => {
    setFetchMock([jsonResponse({}, 401)]);
    await expect(checkerDef.check(makeCtx())).rejects.toThrow(/requires either/);
  });

  it('throws on non-2xx subscription response', async () => {
    setFetchMock([jsonResponse({ error: 'nope' }, 401), jsonResponse(usageResponse)]);
    await expect(checkerDef.check(makeCtx({ apiKey: 'sk-billing' }))).rejects.toThrow(
      /Subscription HTTP 401/
    );
  });

  it('throws when usage response is missing total_usage', async () => {
    setFetchMock([jsonResponse(subscriptionResponse), jsonResponse({ object: 'list' })]);
    await expect(checkerDef.check(makeCtx({ apiKey: 'sk-billing' }))).rejects.toThrow(
      /missing total_usage/
    );
  });
});
