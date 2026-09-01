import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCreditTemplates1786900000000 implements MigrationInterface {
  name = 'AddCreditTemplates1786900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('credit_templates')) return;
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';
    if (isPostgres) {
      await queryRunner.query(
        `CREATE TABLE "credit_templates" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, "name" varchar(100) NOT NULL, "body" text NOT NULL, "type" varchar(20) NOT NULL DEFAULT 'text', "creditCost" integer NOT NULL DEFAULT (1), "mediaUrl" text, "mimetype" varchar, "createdAt" timestamp NOT NULL DEFAULT NOW(), "updatedAt" timestamp NOT NULL DEFAULT NOW())`,
      );
    } else {
      await queryRunner.query(
        `CREATE TABLE "credit_templates" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar(100) NOT NULL, "body" text NOT NULL, "type" varchar(20) NOT NULL DEFAULT ('text'), "creditCost" integer NOT NULL DEFAULT (1), "mediaUrl" text, "mimetype" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`,
      );
    }
    // Seed default template with the example message and costs
    const defaultBody = `Hey! 👋 Kamal here from **Infyle Technologies** 😊

Are you planning to build or upgrade anything tech-related for your business? 🚀

We can help with:
🌐 Websites — ₹15K onwards
📱 Mobile Apps — ₹35K onwards
💻 CRM / Custom Software — ₹40K onwards
🤖 AI Solutions — ₹50K onwards

Have an idea in mind? Just reply **"Hi"** and I'll share some relevant work + pricing. 😊

Let's build something awesome! 🚀`;
    const esc = defaultBody.replace(/'/g, "''");
    await queryRunner.query(
      `INSERT INTO "credit_templates" ("id", "name", "body", "type", "creditCost") VALUES ('default-text', 'Default Text', '${esc}', 'text', 1)`,
    );
    await queryRunner.query(
      `INSERT INTO "credit_templates" ("id", "name", "body", "type", "creditCost") VALUES ('default-image', 'Image Message', 'Image message', 'image', 2)`,
    );
    await queryRunner.query(
      `INSERT INTO "credit_templates" ("id", "name", "body", "type", "creditCost") VALUES ('default-document', 'File/PDF', 'Document message', 'document', 2)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "credit_templates"`);
  }
}
