import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddResellerUsers1786900000001 implements MigrationInterface {
  name = 'AddResellerUsers1786900000001';
  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('reseller_users')) return;
    await queryRunner.query(
      `CREATE TABLE "reseller_users" ("id" varchar PRIMARY KEY NOT NULL, "email" varchar(255) NOT NULL, "passwordHash" varchar(255) NOT NULL, "role" varchar(20) NOT NULL DEFAULT 'demo', "apiKeyId" varchar, "apiKeyRaw" varchar, "credits" integer, "isActive" boolean NOT NULL DEFAULT (1), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_reseller_users_email" UNIQUE ("email"))`,
    );
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "reseller_users"`);
  }
}
