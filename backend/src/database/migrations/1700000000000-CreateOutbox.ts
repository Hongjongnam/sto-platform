import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOutbox1700000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tx_outbox (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        seq bigserial NOT NULL UNIQUE,
        idempotency_key text NOT NULL UNIQUE,
        signer varchar(42) NOT NULL,
        contract text NOT NULL,
        method text NOT NULL,
        args jsonb NOT NULL,
        status text NOT NULL DEFAULT 'PENDING'
          CHECK (status IN ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED')),
        tx_hash varchar(66),
        nonce bigint,
        raw_tx text,
        attempts integer NOT NULL DEFAULT 0,
        error_code text,
        error_message text,
        block_number bigint,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX tx_outbox_open_idx ON tx_outbox (signer, seq) WHERE status IN ('PENDING', 'SUBMITTED')
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE tx_outbox');
  }
}
