import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Protects tables in the PostgREST-exposed public schema from accidental anonymous access.
 * OpenWA uses the database/service-role connection server-side, which bypasses RLS in Supabase.
 */
export class EnableRlsOnPublicTables1787000000000 implements MigrationInterface {
  name = 'EnableRlsOnPublicTables1787000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    for (const table of [
      'ingress_events',
      'messages',
      'migrations',
      'message_batches',
      'templates',
      'baileys_stored_messages',
      'lid_mappings',
      'webhooks',
      'webhook_delivery_failures',
      'plugin_instances',
      'conversation_mappings',
      'integration_delivery_failures',
      'status_updates',
      'automation_rules',
      'sessions',
      'webhook_outbox_events',
      'registry_contacts',
      'registry_blocked',
      'outreach_campaigns',
      'credit_templates',
    ]) {
      await queryRunner.query(`ALTER TABLE IF EXISTS "${table}" ENABLE ROW LEVEL SECURITY`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    for (const table of [
      'ingress_events',
      'messages',
      'migrations',
      'message_batches',
      'templates',
      'baileys_stored_messages',
      'lid_mappings',
      'webhooks',
      'webhook_delivery_failures',
      'plugin_instances',
      'conversation_mappings',
      'integration_delivery_failures',
      'status_updates',
      'automation_rules',
      'sessions',
      'webhook_outbox_events',
      'registry_contacts',
      'registry_blocked',
      'outreach_campaigns',
      'credit_templates',
    ]) {
      await queryRunner.query(`ALTER TABLE IF EXISTS "${table}" DISABLE ROW LEVEL SECURITY`);
    }
  }
}