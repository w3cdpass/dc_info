import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the local cold-outreach registry tables on the DATA connection:
 *  - `registry_contacts`: the app's own dedupe-source address book (unique phone);
 *  - `registry_blocked`: a durable blocked/reported registry (unique phone+kind).
 */
export class AddRegistryTables1786500000000 implements MigrationInterface {
  name = 'AddRegistryTables1786500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';

    if (!(await queryRunner.hasTable('registry_contacts'))) {
      if (isPostgres) {
        await queryRunner.query(
          `CREATE TABLE "registry_contacts" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
            `"phone" varchar(32) NOT NULL, "name" varchar(100), "campaignId" varchar(64), "sessionName" varchar(64), ` +
            `"created_at" timestamp NOT NULL DEFAULT NOW(), "updated_at" timestamp NOT NULL DEFAULT NOW(), ` +
            `CONSTRAINT "UQ_registry_contacts_phone" UNIQUE ("phone"))`,
        );
      } else {
        await queryRunner.query(
          `CREATE TABLE "registry_contacts" ("id" varchar PRIMARY KEY NOT NULL, ` +
            `"phone" varchar(32) NOT NULL, "name" varchar(100), "campaignId" varchar(64), "sessionName" varchar(64), ` +
            `"created_at" datetime NOT NULL DEFAULT (datetime('now')), "updated_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
            `CONSTRAINT "UQ_registry_contacts_phone" UNIQUE ("phone"))`,
        );
      }
      // Index for reply-tracking lookups and sorted listing.
      await queryRunner.query(`CREATE INDEX "IDX_registry_contacts_createdAt" ON "registry_contacts" ("created_at")`).catch(() => {});
    }

    if (!(await queryRunner.hasTable('registry_blocked'))) {
      if (isPostgres) {
        await queryRunner.query(
          `CREATE TABLE "registry_blocked" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
            `"phone" varchar(32) NOT NULL, "kind" varchar(16) NOT NULL DEFAULT 'blocked', "sessionName" varchar(64), ` +
            `"source" varchar(16) NOT NULL DEFAULT 'manual', ` +
            `"created_at" timestamp NOT NULL DEFAULT NOW(), ` +
            `CONSTRAINT "UQ_registry_blocked_phone_kind" UNIQUE ("phone", "kind"))`,
        );
      } else {
        await queryRunner.query(
          `CREATE TABLE "registry_blocked" ("id" varchar PRIMARY KEY NOT NULL, ` +
            `"phone" varchar(32) NOT NULL, "kind" varchar(16) NOT NULL DEFAULT ('blocked'), "sessionName" varchar(64), ` +
            `"source" varchar(16) NOT NULL DEFAULT ('manual'), ` +
            `"created_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
            `CONSTRAINT "UQ_registry_blocked_phone_kind" UNIQUE ("phone", "kind"))`,
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "registry_blocked"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "registry_contacts"`);
  }
}
