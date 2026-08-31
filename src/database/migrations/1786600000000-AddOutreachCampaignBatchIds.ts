import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOutreachCampaignBatchIds1786600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasTable = await queryRunner.hasTable('outreach_campaigns');
    if (!hasTable) return;
    const hasColumn = await queryRunner.hasColumn('outreach_campaigns', 'batchIds');
    if (!hasColumn) {
      await queryRunner.query(`ALTER TABLE "outreach_campaigns" ADD COLUMN "batchIds" TEXT`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const hasColumn = await queryRunner.hasColumn('outreach_campaigns', 'batchIds');
    if (hasColumn) {
      await queryRunner.query(`ALTER TABLE "outreach_campaigns" DROP COLUMN "batchIds"`);
    }
  }
}
