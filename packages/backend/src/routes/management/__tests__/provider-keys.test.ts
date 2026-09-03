/**
 * Tests for the provider-keys management routes.
 *
 * Strategy: drive the routes through `registerManagementRoutes` so the full
 * admin auth chain (authenticate + requireAdmin) runs end-to-end. Mock
 * `ConfigService` (in-memory store) and `getDatabase().transaction` (passthrough)
 * so no real DB is required.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { setConfigForTesting } from '../../../config';
import { registerManagementRoutes } from '../../management';
import { Dispatcher } from '../../../services/dispatch/dispatcher';
import { UsageStorageService } from '../../../services/observability/usage-storage';
import { ProbeService } from '../../../services/probes/probe-service';
import { DebugManager } from '../../../services/observability/debug-manager';
import { SelectorFactory } from '../../../services/routing/selectors/factory';

// ---------------------------------------------------------------------------
// In-memory mock store for provider keys
// ---------------------------------------------------------------------------

interface MockKey {
  id: string;
  provider_id: string; // numeric, as the repo returns it
  label: string;
  api_key: string;
  management_key?: string;
  notes?: string;
  enabled: boolean;
  priority: number;
}

const mockState = vi.hoisted(() => {
  // Maps numeric provider id → slug
  const providerSlugById: Record<string, string> = {};
  // Maps slug → numeric provider id
  const providerIdBySlug: Record<string, string> = {};
  const keys: MockKey[] = [];

  return {
    providerSlugById,
    providerIdBySlug,
    keys,
    reset() {
      for (const k of Object.keys(providerSlugById)) delete providerSlugById[k];
      for (const k of Object.keys(providerIdBySlug)) delete providerIdBySlug[k];
      keys.length = 0;
    },
  };
});

vi.mock('../../../db/client', () => ({
  getDatabase: vi.fn(() => ({
    transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})),
  })),
  getSchema: vi.fn(() => ({})),
  getCurrentDialect: vi.fn(() => 'sqlite'),
}));

vi.mock('../../../services/configuration/config-service', () => {
  const buildRepo = () => {
    const sortedKeysFor = (providerId: string) =>
      mockState.keys
        .filter((k) => String(k.provider_id) === String(providerId))
        .slice()
        .sort((a, b) => a.priority - b.priority);

    return {
      resolveProviderId: vi.fn(async (ref: string) => {
        // Numeric lookup first
        if (mockState.providerSlugById[ref]) return Number(ref);
        // Slug lookup
        const id = mockState.providerIdBySlug[ref];
        return id === undefined ? undefined : Number(id);
      }),
      getAllProviderKeys: vi.fn(async () => mockState.keys.slice()),
      getProviderKeys: vi.fn(async (providerRef: string) => {
        // Allow slug or numeric id
        let id: string | undefined = providerRef;
        if (mockState.providerSlugById[providerRef]) {
          id = providerRef;
        } else if (mockState.providerIdBySlug[providerRef]) {
          id = mockState.providerIdBySlug[providerRef];
        } else {
          // Could be a numeric id passed straight through
          const numeric = Number(providerRef);
          if (Number.isFinite(numeric) && mockState.providerSlugById[String(numeric)]) {
            id = String(numeric);
          } else if (Number.isFinite(numeric)) {
            id = String(numeric);
          } else {
            return [];
          }
        }
        return sortedKeysFor(id);
      }),
      saveProviderKey: vi.fn(async (id: string, data: any) => {
        const existing = mockState.keys.find((k) => k.id === id);
        const stored: MockKey = {
          id,
          provider_id: String(data.provider_id),
          label: data.label,
          api_key: data.api_key,
          management_key: data.management_key,
          notes: data.notes,
          enabled: data.enabled,
          priority: data.priority,
        };
        if (existing) Object.assign(existing, stored);
        else mockState.keys.push(stored);
        return { ...stored };
      }),
      deleteProviderKey: vi.fn(async (id: string) => {
        const idx = mockState.keys.findIndex((k) => k.id === id);
        if (idx === -1) return false;
        mockState.keys.splice(idx, 1);
        return true;
      }),
      getProviderIdToSlugMap: vi.fn(async () => {
        const map = new Map<string, string>();
        for (const [id, slug] of Object.entries(mockState.providerSlugById)) {
          map.set(id, slug);
        }
        return map;
      }),
    };
  };

  return {
    ConfigService: {
      getInstance: vi.fn(() => ({
        getRepository: vi.fn(buildRepo),
        flush: vi.fn(async () => {}),
      })),
    },
  };
});

// ---------------------------------------------------------------------------
// Shared test setup
// ---------------------------------------------------------------------------

const closeFastify = async (fastify: FastifyInstance | undefined) => {
  if (fastify) await fastify.close();
};

const BASE_CONFIG = {
  providers: {},
  models: {},
  keys: {
    'admin-only-key': { secret: 'sk-test-secret' },
  },
  failover: {
    enabled: false,
    retryableStatusCodes: [429, 500, 502, 503, 504],
    retryableErrors: ['ECONNREFUSED', 'ETIMEDOUT'],
  },
  quotas: [],
};

const originalAdminKey = process.env.ADMIN_KEY;
const ADMIN_KEY = 'correct-admin-key';
const AUTH_HEADERS = { 'x-admin-key': ADMIN_KEY };

const makeMockDeps = () => {
  const mockUsageStorage = {
    saveRequest: vi.fn(),
    saveError: vi.fn(),
    updatePerformanceMetrics: vi.fn(),
    emitStartedAsync: vi.fn(),
    emitUpdatedAsync: vi.fn(),
  } as unknown as UsageStorageService;

  const mockDispatcher = {
    dispatch: vi.fn(async () => ({
      id: 'test-id',
      model: 'test-model',
      created: Date.now(),
      content: 'ok',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })),
  } as unknown as Dispatcher;

  const mockProbeService = {
    runProbe: vi.fn(async () => ({
      success: true,
      durationMs: 0,
      apiType: 'chat' as const,
      response: 'ok',
    })),
  } as unknown as ProbeService;

  return { mockUsageStorage, mockDispatcher, mockProbeService };
};

/**
 * Seed the in-memory provider store with an `openai` provider (id=1) and
 * an `anthropic` provider (id=2). Returns nothing — the mock state is
 * shared via `mockState`.
 */
const seedProviders = () => {
  mockState.providerSlugById['1'] = 'openai';
  mockState.providerIdBySlug['openai'] = '1';
  mockState.providerSlugById['2'] = 'anthropic';
  mockState.providerIdBySlug['anthropic'] = '2';
};

beforeEach(() => {
  process.env.ADMIN_KEY = ADMIN_KEY;
  mockState.reset();
  seedProviders();
  setConfigForTesting(BASE_CONFIG);
  DebugManager.getInstance().resetForTesting();
  DebugManager.getInstance().setEnabled(false);
});

afterEach(() => {
  process.env.ADMIN_KEY = originalAdminKey;
  DebugManager.getInstance().resetForTesting();
  DebugManager.getInstance().setEnabled(false);
  SelectorFactory.setUsageStorage(null as any);
  DebugManager.getInstance().setStorage(null as any);
});

afterAll(() => {
  if (originalAdminKey === undefined) {
    delete process.env.ADMIN_KEY;
  } else {
    process.env.ADMIN_KEY = originalAdminKey;
  }
});

let fastify: FastifyInstance;

beforeEach(async () => {
  fastify = Fastify();
  const { mockUsageStorage, mockDispatcher, mockProbeService } = makeMockDeps();
  await registerManagementRoutes(fastify, mockUsageStorage, mockDispatcher, mockProbeService);
  await fastify.ready();
});

afterEach(async () => {
  await closeFastify(fastify);
});

// ---------------------------------------------------------------------------
// POST /v0/management/provider-keys
// ---------------------------------------------------------------------------

describe('POST /v0/management/provider-keys', () => {
  it('creates a key and returns 201 with the full record (api_key visible)', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/v0/management/provider-keys',
      headers: AUTH_HEADERS,
      payload: {
        provider_id: 'openai',
        label: 'k1',
        api_key: 'sk-test',
        enabled: true,
        priority: 1,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { key: MockKey };
    expect(body.key.api_key).toBe('sk-test');
    expect(body.key.label).toBe('k1');
    expect(body.key.provider_id).toBe('openai');
    expect(body.key.priority).toBe(1);
    expect(typeof body.key.id).toBe('string');
    expect(body.key.id.length).toBeGreaterThan(0);
  });

  it('auto-generates a UUID label when label is omitted', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/v0/management/provider-keys',
      headers: AUTH_HEADERS,
      payload: {
        provider_id: 'openai',
        api_key: 'sk-auto-label',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { key: MockKey };
    expect(body.key.label).toBeTruthy();
    // UUID v4 pattern: 8-4-4-4-12 hex chars
    expect(body.key.label).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

// ---------------------------------------------------------------------------
// GET /v0/management/provider-keys
// ---------------------------------------------------------------------------

describe('GET /v0/management/provider-keys', () => {
  it('returns all provider keys after seeding two', async () => {
    const seed = await fastify.inject({
      method: 'POST',
      url: '/v0/management/provider-keys',
      headers: AUTH_HEADERS,
      payload: { provider_id: 'openai', label: 'one', api_key: 'sk-1' },
    });
    expect(seed.statusCode).toBe(201);

    const seed2 = await fastify.inject({
      method: 'POST',
      url: '/v0/management/provider-keys',
      headers: AUTH_HEADERS,
      payload: { provider_id: 'openai', label: 'two', api_key: 'sk-2' },
    });
    expect(seed2.statusCode).toBe(201);

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/provider-keys',
      headers: AUTH_HEADERS,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { keys: MockKey[] };
    expect(body.keys).toHaveLength(2);
    expect(body.keys.map((k) => k.label).sort()).toEqual(['one', 'two']);
  });

  it('filters by ?provider_id=openai and returns only those keys', async () => {
    await fastify.inject({
      method: 'POST',
      url: '/v0/management/provider-keys',
      headers: AUTH_HEADERS,
      payload: { provider_id: 'openai', label: 'openai-only', api_key: 'sk-oai' },
    });
    await fastify.inject({
      method: 'POST',
      url: '/v0/management/provider-keys',
      headers: AUTH_HEADERS,
      payload: { provider_id: 'anthropic', label: 'anthro-only', api_key: 'sk-ant' },
    });

    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/provider-keys?provider_id=openai',
      headers: AUTH_HEADERS,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { keys: MockKey[] };
    expect(body.keys).toHaveLength(1);
    const firstKey = body.keys[0]!;
    expect(firstKey.provider_id).toBe('openai');
    expect(firstKey.label).toBe('openai-only');
  });
});

// ---------------------------------------------------------------------------
// PUT /v0/management/provider-keys/:id
// ---------------------------------------------------------------------------

describe('PUT /v0/management/provider-keys/:id', () => {
  it('updates the priority of an existing key and returns 200', async () => {
    const created = await fastify.inject({
      method: 'POST',
      url: '/v0/management/provider-keys',
      headers: AUTH_HEADERS,
      payload: { provider_id: 'openai', label: 'to-update', api_key: 'sk-x' },
    });
    const { key } = created.json() as { key: MockKey };

    const res = await fastify.inject({
      method: 'PUT',
      url: `/v0/management/provider-keys/${key.id}`,
      headers: AUTH_HEADERS,
      payload: { priority: 5 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { key: MockKey };
    expect(body.key.priority).toBe(5);
    expect(body.key.id).toBe(key.id);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v0/management/provider-keys/:id
// ---------------------------------------------------------------------------

describe('DELETE /v0/management/provider-keys/:id', () => {
  it('returns 204 and reduces the key count by one', async () => {
    const a = await fastify.inject({
      method: 'POST',
      url: '/v0/management/provider-keys',
      headers: AUTH_HEADERS,
      payload: { provider_id: 'openai', label: 'del-a', api_key: 'sk-a' },
    });
    const b = await fastify.inject({
      method: 'POST',
      url: '/v0/management/provider-keys',
      headers: AUTH_HEADERS,
      payload: { provider_id: 'openai', label: 'del-b', api_key: 'sk-b' },
    });
    const aKey = (a.json() as { key: MockKey }).key;
    const bKey = (b.json() as { key: MockKey }).key;

    const del = await fastify.inject({
      method: 'DELETE',
      url: `/v0/management/provider-keys/${aKey.id}`,
      headers: AUTH_HEADERS,
    });
    expect(del.statusCode).toBe(204);

    const list = await fastify.inject({
      method: 'GET',
      url: '/v0/management/provider-keys',
      headers: AUTH_HEADERS,
    });
    const body = list.json() as { keys: MockKey[] };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]!.id).toBe(bKey.id);
  });
});

// ---------------------------------------------------------------------------
// POST /v0/management/provider-keys/bulk
// ---------------------------------------------------------------------------

describe('POST /v0/management/provider-keys/bulk', () => {
  it('creates all keys in a single batch and returns 201', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/v0/management/provider-keys/bulk',
      headers: AUTH_HEADERS,
      payload: {
        provider_id: 'openai',
        keys: [
          { label: 'b1', api_key: 'sk-1' },
          { label: 'b2', api_key: 'sk-2' },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { keys: MockKey[] };
    expect(body.keys).toHaveLength(2);
    expect(body.keys.map((k) => k.label).sort()).toEqual(['b1', 'b2']);
    expect(body.keys.map((k) => k.api_key).sort()).toEqual(['sk-1', 'sk-2']);
  });
});

// ---------------------------------------------------------------------------
// Auth: every endpoint rejects unauthenticated requests with 401
// ---------------------------------------------------------------------------

describe('provider-keys auth enforcement', () => {
  it('rejects GET without x-admin-key', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/provider-keys',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects GET (filtered) without x-admin-key', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/v0/management/provider-keys?provider_id=openai',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects POST without x-admin-key', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/v0/management/provider-keys',
      payload: { provider_id: 'openai', api_key: 'sk-x' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects PUT without x-admin-key', async () => {
    const res = await fastify.inject({
      method: 'PUT',
      url: '/v0/management/provider-keys/some-id',
      payload: { priority: 1 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects POST /bulk without x-admin-key', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/v0/management/provider-keys/bulk',
      payload: {
        provider_id: 'openai',
        keys: [{ label: 'b', api_key: 'sk' }],
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects DELETE without x-admin-key', async () => {
    const res = await fastify.inject({
      method: 'DELETE',
      url: '/v0/management/provider-keys/some-id',
    });
    expect(res.statusCode).toBe(401);
  });
});
