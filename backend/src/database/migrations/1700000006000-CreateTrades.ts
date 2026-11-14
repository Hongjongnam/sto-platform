import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateTrades1700000006000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE trades (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        trade_no text NOT NULL UNIQUE,
        trade_id varchar(66) NOT NULL,
        seller varchar(42) NOT NULL REFERENCES wallets (address),
        buyer varchar(42) NOT NULL REFERENCES wallets (address),
        quantity numeric(78, 0) NOT NULL CHECK (quantity > 0),
        price numeric(78, 0) NOT NULL CHECK (price >= 0),
        expiry timestamptz NOT NULL,
        create_outbox_id uuid NOT NULL REFERENCES tx_outbox (id),
        settle_outbox_id uuid NOT NULL REFERENCES tx_outbox (id),
        cancel_outbox_id uuid REFERENCES tx_outbox (id),
        settle_attempts integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK (seller <> buyer)
      )
    `);
    await queryRunner.query('CREATE SEQUENCE otc_trade_seq');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP SEQUENCE otc_trade_seq');
    await queryRunner.query('DROP TABLE trades');
  }
}
