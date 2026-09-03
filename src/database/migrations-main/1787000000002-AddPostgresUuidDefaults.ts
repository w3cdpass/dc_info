import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Repairs PostgreSQL tables created by earlier migrations without UUID defaults.
 * TypeORM generates UUID values for new entities only when the metadata and schema agree;
 * existing installations created with a plain varchar primary key otherwise insert NULL.
 */
export class AddPostgresUuidDefaults1787000000002 implements MigrationInterface {
  name = 'AddPostgresUuidDefaults1787000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    for (const table of ['api_keys', 'audit_logs', 'reseller_users']) {
      await queryRunner.query(
        `ALTER TABLE IF EXISTS "${table}" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::varchar`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    for (const table of ['api_keys', 'audit_logs', 'reseller_users']) {
      await queryRunner.query(`ALTER TABLE IF EXISTS "${table}" ALTER COLUMN "id" DROP DEFAULT`);
    }
  }
}