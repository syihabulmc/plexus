import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, getCurrentDialect, initializeDatabase } from '../client';

const prevToken = process.env.TURSO_AUTH_TOKEN;

describe('initializeDatabase with libsql:// (Turso)', () => {
  beforeEach(async () => {
    await closeDatabase();
    delete process.env.TURSO_AUTH_TOKEN;
  });

  afterEach(async () => {
    await closeDatabase();
    if (prevToken !== undefined) process.env.TURSO_AUTH_TOKEN = prevToken;
    else delete process.env.TURSO_AUTH_TOKEN;
  });

  it('fails fast when TURSO_AUTH_TOKEN is absent and the URL carries none', () => {
    expect(() => initializeDatabase('libsql://plexus-myorg.turso.io')).toThrow(
      'TURSO_AUTH_TOKEN'
    );
  });

  it('builds a drizzle sqlite instance off TURSO_AUTH_TOKEN without dialing out', () => {
    process.env.TURSO_AUTH_TOKEN = 'test-token';
    const db = initializeDatabase('libsql://plexus-myorg.turso.io');
    expect(db).toBeDefined();
    expect(getCurrentDialect()).toBe('sqlite');
  });
});
