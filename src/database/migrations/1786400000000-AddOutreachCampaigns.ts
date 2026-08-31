import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `outreach_campaigns` — multi-session round-robin cold-outreach waves. All structured
 * payloads (`variableMap`, `contacts`, `sessions`, `strategy`, `distribution`, `sessionProgress`)
 * are stored as plain text (`simple-json` on both dialects, never jsonb), matching the entity
 * metadata and the codebase's cross-dialect convention. There is intentionally no FK to sessions:
 * the session pool is a snapshot embedded in JSON.
 */
export class AddOutreachCampaigns1786400000000 implements MigrationInterface {
  name = 'AddOutreachCampaigns1786400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('outreach_campaigns')) return;
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';

    if (isPostgres) {
      await queryRunner.query(
        `CREATE TABLE "outreach_campaigns" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
          `"name" varchar(100) NOT NULL, "status" varchar(20) NOT NULL DEFAULT 'scheduled', ` +
          `"messageText" text NOT NULL, "variableMap" text, "contacts" text NOT NULL, "sessions" text NOT NULL, ` +
          `"strategy" text NOT NULL, "distribution" text, "sessionProgress" text, "error" text, ` +
          `"created_at" timestamp NOT NULL DEFAULT NOW(), "updated_at" timestamp NOT NULL DEFAULT NOW(), ` +
          `"started_at" timestamp, "completed_at" timestamp)`,
      );
    } else {
      await queryRunner.query(
        `CREATE TABLE "outreach_campaigns" ("id" varchar PRIMARY KEY NOT NULL, ` +
          `"name" varchar(100) NOT NULL, "status" varchar(20) NOT NULL DEFAULT ('scheduled'), ` +
          `"messageText" text NOT NULL, "variableMap" text, "contacts" text NOT NULL, "sessions" text NOT NULL, ` +
          `"strategy" text NOT NULL, "distribution" text, "sessionProgress" text, "error" text, ` +
          `"created_at" datetime NOT NULL DEFAULT (datetime('now')), "updated_at" datetime NOT NULL DEFAULT (datetime('now')), ` +
          `"started_at" text, "completed_at" text)`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // IF EXISTS so revert is idempotent on a synchronize-bootstrapped DB.
    await queryRunner.query(`DROP TABLE IF EXISTS "outreach_campaigns"`);
  }
}
