import { FastifyInstance } from 'fastify';
import { CooldownManager } from '../../services/runtime/cooldown-manager';
import { logger } from '../../utils/logger';
import { requireAdmin } from './_principal';

export async function registerCooldownRoutes(fastify: FastifyInstance) {
  // Read-only view is available to both admin and limited users; cooldown data
  // is provider-level (not per-key) but useful for debugging request failures.
  fastify.get('/v0/management/cooldowns', (request, reply) => {
    const cooldowns = CooldownManager.getInstance().getCooldowns();
    return reply.send(cooldowns);
  });

  // Clearing cooldowns (all or per-provider) is admin-only. The router uses
  // cooldowns to steer away from providers with real failure signals (rate
  // limits, outages, quota exhaustion), so forcing a retry has system-wide
  // blast radius and is not a safe self-service action for a key holder.
  fastify.delete('/v0/management/cooldowns', { preHandler: requireAdmin }, (_request, reply) => {
    CooldownManager.getInstance().clearCooldown();
    logger.info('[AUDIT] admin cleared all cooldowns');
    return reply.send({ success: true });
  });

  fastify.delete(
    '/v0/management/cooldowns/:provider',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const params = request.params as any;
      const query = request.query as any;
      const provider = params.provider as string;
      const model = query.model as string | undefined;
      const keyId = query.keyId as string | undefined;

      // Per-key clear: only the matching per-key slot is removed. This
      // is what the Cooldowns UI invokes for a per-row X button on a
      // per-key entry — model-level siblings are intentionally left in
      // place so an admin clearing one stale key does not silently
      // wipe the entire model's circuit-breaker state.
      if (keyId && model) {
        logger.info(
          `[AUDIT] admin cleared per-key cooldown for provider='${provider}' model='${model}' key='${keyId}'`
        );
        await CooldownManager.getInstance().clearKeyCooldown(provider, model, keyId);
        return reply.send({ success: true });
      }

      logger.info(
        `[AUDIT] admin cleared cooldown for provider='${provider}' model='${model ?? '*'}'`
      );

      CooldownManager.getInstance().clearCooldown(provider, model);
      return reply.send({ success: true });
    }
  );
}
