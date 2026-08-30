import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { ConfigService } from '../../services/configuration/config-service';

/**
 * Provider keys management routes. Admin-only. Each key is treated as
 * a first-class identity for routing, cooldowns, quota, and logs.
 *
 * Endpoints:
 *   GET    /v0/management/provider-keys?provider_id=
 *   POST   /v0/management/provider-keys       (create)
 *   PUT    /v0/management/provider-keys/:id   (update)
 *   POST   /v0/management/provider-keys/bulk  (create many)
 *   DELETE /v0/management/provider-keys/:id   (delete)
 *
 * `provider_id` is exposed as a slug on the wire; the DB column is a
 * numeric FK resolved via `ConfigRepository.resolveProviderId`.
 *
 * Every write calls `ConfigService.flush()` so the in-memory `api_keys`
 * array on `providers[slug]` reflects the change immediately (e.g.
 * a newly disabled key disappears from the dispatcher's view).
 */

const ProviderKeySchema = z.object({
  provider_id: z.string().min(1, 'provider_id is required'),
  label: z.string().default(''),
  api_key: z.string().min(1, 'api_key is required'),
  management_key: z.string().optional(),
  notes: z.string().optional(),
  enabled: z.boolean().default(true),
  // priority is optional on create — when omitted, the key is appended
  // to the end of the provider's existing sequence.
  priority: z.number().int().optional(),
});

const UpdateProviderKeySchema = z.object({
  provider_id: z.string().min(1).optional(),
  label: z.string().optional(),
  api_key: z.string().min(1).optional(),
  management_key: z.string().optional(),
  notes: z.string().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
});

/**
 * Provider key labels must always be non-empty (the Logs page renders
 * the label, and we want a stable identifier even if the user
 * submitted blank). Fall back to a random UUID when none is supplied.
 */
function ensureLabel(label: string | undefined): string {
  return label && label.trim().length > 0 ? label : randomUUID();
}

/**
 * Re-assign gapless priorities 1..N for one provider's keys. The
 * target key is placed at `position` (0-based; >= key count = end of
 * the sequence). The other keys keep their relative order. Only rows
 * whose priority actually changes are written back. Lower priority
 * number = earlier in the routing order.
 */
async function resequenceProviderKeys(
  repo: ReturnType<ConfigService['getRepository']>,
  providerId: string,
  targetId: string,
  position: number
): Promise<void> {
  const keys = await repo.getProviderKeys(providerId);
  const target = keys.find((k) => (k as any).id === targetId);
  if (!target) return;
  const ordered = keys.filter((k: any) => (k as any).id !== targetId);
  ordered.splice(Math.min(position, ordered.length), 0, target);
  let next = 1;
  for (const k of ordered as any[]) {
    if (k.priority !== next) {
      await repo.saveProviderKey(k.id, {
        provider_id: k.provider_id,
        label: k.label,
        api_key: k.api_key,
        management_key: k.management_key,
        notes: k.notes,
        enabled: k.enabled,
        priority: next,
      });
    }
    next++;
  }
}

export async function registerProviderKeyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/v0/management/provider-keys', async (request: any, reply) => {
    const repo = ConfigService.getInstance().getRepository();
    const { provider_id } = request.query as { provider_id?: string };
    let keys: any[];
    if (provider_id) {
      const resolved = await repo.resolveProviderId(provider_id);
      if (resolved === undefined) {
        return reply.status(400).send({ error: `Provider '${provider_id}' not found` });
      }
      keys = await repo.getProviderKeys(String(resolved));
    } else {
      keys = await repo.getAllProviderKeys();
    }
    // Expose provider_id as a slug, not the numeric FK
    const idToSlug = await repo.getProviderIdToSlugMap();
    return { keys: keys.map((k) => ({ ...k, provider_id: idToSlug.get(k.provider_id) ?? k.provider_id })) };
  });

  fastify.post('/v0/management/provider-keys', async (request: any, reply) => {
    const parsed = ProviderKeySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const data = parsed.data;
    const configService = ConfigService.getInstance();
    const repo = configService.getRepository();

    const providerId = await repo.resolveProviderId(data.provider_id);
    if (providerId === undefined) {
      return reply.status(400).send({ error: `Provider '${data.provider_id}' not found` });
    }

    const id = randomUUID();
    const { priority, ...rest } = parsed.data;
    // Normalize notes for POST: '' (the only way to send "clear" since
    // Zod treats null as type error) becomes '' which the repo
    // interprets as "no note".
    const postNotes = rest.notes === '' ? '' : rest.notes;
    const key = await repo.saveProviderKey(id, {
      ...rest,
      notes: postNotes,
      label: ensureLabel(rest.label),
      provider_id: String(providerId),
      priority: priority ?? 0,
    });
    // Empty priority = append to the end; an explicit priority positions
    // the key at that place and shifts the rest.
    await resequenceProviderKeys(
      repo,
      String(providerId),
      id,
      priority !== undefined && priority >= 1 ? priority - 1 : Number.MAX_SAFE_INTEGER
    );
    // Repo writes bypass ConfigService's cache invalidation — rebuild
    // so the dispatcher / quota menu reflect the change.
    await configService.flush();
    const idToSlug = await repo.getProviderIdToSlugMap();
    return reply
      .status(201)
      .send({ key: { ...key, provider_id: idToSlug.get(key.provider_id) ?? key.provider_id } });
  });

  fastify.put('/v0/management/provider-keys/:id', async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const parsed = UpdateProviderKeySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const configService = ConfigService.getInstance();
    const repo = configService.getRepository();

    const allKeys = await repo.getAllProviderKeys();
    const existing = allKeys.find((k) => (k as any).id === id);
    if (!existing) {
      return reply.status(404).send({ error: 'Provider key not found' });
    }

    let providerId = existing.provider_id;
    let providerChanged = false;
    if (parsed.data.provider_id !== undefined) {
      const resolved = await repo.resolveProviderId(parsed.data.provider_id);
      if (resolved === undefined) {
        return reply.status(400).send({ error: `Provider '${parsed.data.provider_id}' not found` });
      }
      if (String(resolved) !== String(existing.provider_id)) {
        providerChanged = true;
      }
      providerId = String(resolved);
    }

    // management_key semantics: undefined = keep, '' = clear, value = set
    let managementKeyToWrite: string | undefined = existing.management_key;
    if (parsed.data.management_key === '') {
      managementKeyToWrite = '';
    } else if (parsed.data.management_key !== undefined) {
      managementKeyToWrite = parsed.data.management_key;
    }

    // Same 3-state semantics for notes: undefined = keep, '' = clear,
    // value = set. Without this, the frontend couldn't intentionally
    // clear a note via the toggle path.
    let notesToWrite: string | undefined = existing.notes ?? undefined;
    if (parsed.data.notes === '') {
      notesToWrite = '';
    } else if (parsed.data.notes !== undefined) {
      notesToWrite = parsed.data.notes;
    }

    const merged = {
      provider_id: providerId,
      label: ensureLabel(parsed.data.label ?? existing.label),
      api_key: parsed.data.api_key ?? existing.api_key,
      management_key: managementKeyToWrite,
      notes: notesToWrite,
      enabled: parsed.data.enabled ?? existing.enabled,
      priority: parsed.data.priority ?? existing.priority,
    };

    const key = await repo.saveProviderKey(id, merged);
    if (providerChanged) {
      // Moving a key between providers leaves a gap in the old provider's
      // priority sequence. Resequence BOTH providers to maintain 1..N.
      await resequenceProviderKeys(
        repo,
        String(existing.provider_id),
        id,
        Number.MAX_SAFE_INTEGER // append to the end of the new provider
      );
      await resequenceProviderKeys(
        repo,
        providerId,
        id,
        Number.MAX_SAFE_INTEGER
      );
    } else if (parsed.data.priority !== undefined) {
      await resequenceProviderKeys(
        repo,
        providerId,
        id,
        parsed.data.priority >= 1 ? parsed.data.priority - 1 : Number.MAX_SAFE_INTEGER
      );
    }
    await configService.flush();
    const idToSlug = await repo.getProviderIdToSlugMap();
    return { key: { ...key, provider_id: idToSlug.get(key.provider_id) ?? key.provider_id } };
  });

  fastify.post('/v0/management/provider-keys/bulk', async (request: any, reply) => {
    const BulkSchema = z.object({
      provider_id: z.string().min(1, 'provider_id is required'),
      keys: z
        .array(
          z.object({
            label: z.string().optional().default(''),
            api_key: z.string().min(1, 'api_key is required'),
            enabled: z.boolean().optional().default(true),
            priority: z.number().int().optional(),
          })
        )
        .min(1, 'at least one key is required'),
    });

    const parsed = BulkSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const { provider_id, keys: bulkKeys } = parsed.data;
    const configService = ConfigService.getInstance();
    const repo = configService.getRepository();

    const providerId = await repo.resolveProviderId(provider_id);
    if (providerId === undefined) {
      return reply.status(400).send({ error: `Provider '${provider_id}' not found` });
    }

    // Batch start = first explicit priority in the batch, else continue
    // from the provider's last number; each key gets the next number in
    // sequence.
    const existing = await repo.getProviderKeys(String(providerId));
    const maxExisting = existing.reduce((m, k) => Math.max(m, (k as any).priority), 0);
    const requested = bulkKeys.find((k) => k.priority !== undefined && k.priority >= 1)?.priority;
    let next = requested ?? maxExisting + 1;

    const created: any[] = [];
    for (const k of bulkKeys) {
      const id = randomUUID();
      const key = await repo.saveProviderKey(id, {
        provider_id: String(providerId),
        label: ensureLabel(k.label),
        api_key: k.api_key,
        enabled: k.enabled ?? true,
        priority: next,
      });
      created.push(key);
      next += 1;
    }

    await configService.flush();

    const idToSlug = await repo.getProviderIdToSlugMap();
    return reply.status(201).send({
      keys: created.map((k) => ({ ...k, provider_id: idToSlug.get(k.provider_id) ?? k.provider_id })),
    });
  });

  fastify.delete('/v0/management/provider-keys/:id', async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const configService = ConfigService.getInstance();
    const repo = configService.getRepository();

    const deleted = await repo.deleteProviderKey(id);
    if (!deleted) {
      return reply.status(404).send({ error: 'Provider key not found' });
    }

    await configService.flush();
    return reply.status(204).send();
  });
}
