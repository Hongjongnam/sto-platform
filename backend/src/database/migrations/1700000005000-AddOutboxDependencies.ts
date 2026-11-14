import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOutboxDependencies1700000005000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE tx_outbox ADD COLUMN depends_on uuid[] NOT NULL DEFAULT '{}'`);
    await queryRunner.query(`ALTER TABLE tx_outbox ADD COLUMN runs_after uuid[] NOT NULL DEFAULT '{}'`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE tx_outbox DROP COLUMN runs_after');
    await queryRunner.query('ALTER TABLE tx_outbox DROP COLUMN depends_on');
  }
}
