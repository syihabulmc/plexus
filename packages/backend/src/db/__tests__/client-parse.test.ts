import { describe, expect, it } from 'vitest';
import { parseConnectionString } from '../client';

describe('parseConnectionString', () => {
  it('keeps parsing sqlite:// as local sqlite', () => {
    expect(parseConnectionString('sqlite:///tmp/db.sqlite')).toEqual({
      dialect: 'sqlite',
      connectionString: '/tmp/db.sqlite',
    });
  });

  it('parses libsql:// as sqlite dialect with the URL passed through', () => {
    expect(parseConnectionString('libsql://plexus-myorg.turso.io')).toEqual({
      dialect: 'sqlite',
      connectionString: 'libsql://plexus-myorg.turso.io',
    });
    expect(parseConnectionString('libsql://db.turso.io?authToken=tok123')).toEqual({
      dialect: 'sqlite',
      connectionString: 'libsql://db.turso.io?authToken=tok123',
    });
  });

  it('still rejects unknown schemes and mentions libsql in the error', () => {
    expect(() => parseConnectionString('mysql://localhost/db')).toThrow('libsql://');
  });
});
