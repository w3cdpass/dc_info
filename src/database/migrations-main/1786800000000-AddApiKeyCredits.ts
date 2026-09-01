import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddApiKeyCredits1786800000000 implements MigrationInterface {
  name = 'AddApiKeyCredits1786800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasTable = await queryRunner.hasTable('api_keys');
    if (!hasTable) return;
    if (!(await queryRunner.hasColumn('api_keys', 'credits'))) {
      await queryRunner.query(`ALTER TABLE "api_keys" ADD COLUMN "credits" integer`);
    }
    if (!(await queryRunner.hasColumn('api_keys', 'creditsUsed'))) {
      await queryRunner.query(`ALTER TABLE "api_keys" ADD COLUMN "creditsUsed" integer NOT NULL DEFAULT (0)`);
    }
    if (!(await queryRunner.hasColumn('api_keys', 'creditCost'))) {
      await queryRunner.query(`ALTER TABLE "api_keys" ADD COLUMN "creditCost" text`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('api_keys', 'creditCost')) {
      await queryRunner.query(`ALTER TABLE "api_keys" DROP COLUMN "creditCost"`);
    }
    if (await queryRunner.hasColumn('api_keys', 'creditsUsed')) {
      await queryRunner.query(`ALTER TABLE "api_keys" DROP COLUMN "creditsUsed"`);
    }
    if (await queryRunner.hasColumn('api_keys', 'credits')) {
      await queryRunner.query(`ALTER TABLE "api_keys" DROP COLUMN "credits"`);
    }
  }
}
