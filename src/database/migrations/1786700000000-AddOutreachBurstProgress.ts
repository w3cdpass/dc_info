import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOutreachBurstProgress1786700000000 implements MigrationInterface {
  name = 'AddOutreachBurstProgress1786700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasTable = await queryRunner.hasTable('outreach_campaigns');
    if (!hasTable) return;
    const hasBurstProgress = await queryRunner.hasColumn('outreach_campaigns', 'burstProgress');
    if (!hasBurstProgress) {
      await queryRunner.query(`ALTER TABLE "outreach_campaigns" ADD COLUMN "burstProgress" TEXT`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const hasColumn = await queryRunner.hasColumn('outreach_campaigns', 'burstProgress');
    if (hasColumn) {
      await queryRunner.query(`ALTER TABLE "outreach_campaigns" DROP COLUMN "burstProgress"`);
    }
  }
}
