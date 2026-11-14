import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCorporateActions1700000007000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE corporate_actions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind text NOT NULL CHECK (kind IN ('DIVIDEND', 'REDEMPTION')),
        amount numeric(78, 0) NOT NULL,
        record_block bigint,
        deadline timestamptz NOT NULL,
        open_outbox_id uuid NOT NULL REFERENCES tx_outbox (id),
        close_outbox_id uuid REFERENCES tx_outbox (id),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE corporate_action_claims (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        action_id uuid NOT NULL REFERENCES corporate_actions (id),
        wallet varchar(42) NOT NULL REFERENCES wallets (address),
        quantity numeric(78, 0),
        outbox_id uuid NOT NULL REFERENCES tx_outbox (id),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX corporate_action_claims_action_idx ON corporate_action_claims (action_id)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE corporate_action_claims');
    await queryRunner.query('DROP TABLE corporate_actions');
  }
}
