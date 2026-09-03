import { AddPostgresUuidDefaults1787000000002 } from '../1787000000002-AddPostgresUuidDefaults';

describe('AddPostgresUuidDefaults migration', () => {
  it('adds UUID defaults to existing PostgreSQL tables', async () => {
    const queries: string[] = [];
    const qr = {
      connection: { options: { type: 'postgres' } },
      query: async (sql: string) => {
        queries.push(sql);
        return [];
      },
    } as never;

    await new AddPostgresUuidDefaults1787000000002().up(qr);

    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain('"api_keys" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::varchar');
    expect(queries[2]).toContain('"reseller_users" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::varchar');
  });

  it('does nothing on SQLite', async () => {
    const query = jest.fn();
    const qr = { connection: { options: { type: 'better-sqlite3' } }, query } as never;

    await new AddPostgresUuidDefaults1787000000002().up(qr);

    expect(query).not.toHaveBeenCalled();
  });
});