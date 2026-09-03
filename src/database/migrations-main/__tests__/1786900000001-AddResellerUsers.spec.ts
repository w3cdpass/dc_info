import { DataSource } from 'typeorm';
import { AddResellerUsers1786900000001 } from '../1786900000001-AddResellerUsers';

describe('AddResellerUsers migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], synchronize: false });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('creates the reseller_users table on SQLite', async () => {
    const qr = ds.createQueryRunner();
    await new AddResellerUsers1786900000001().up(qr);
    expect(await qr.hasTable('reseller_users')).toBe(true);
    await qr.release();
  });

  it('uses PostgreSQL-compatible DDL', async () => {
    const queries: string[] = [];
    const qr = {
      connection: { options: { type: 'postgres' } },
      hasTable: async () => false,
      query: async (sql: string) => {
        queries.push(sql);
        return [];
      },
    } as never;

    await new AddResellerUsers1786900000001().up(qr);

    expect(queries[0]).toContain('DEFAULT gen_random_uuid()::varchar');
    expect(queries[0]).toContain('"createdAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP');
    expect(queries[0]).not.toContain('datetime');
  });
});