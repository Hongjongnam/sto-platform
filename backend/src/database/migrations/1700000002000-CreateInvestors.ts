import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateInvestors1700000002000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE investors (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        investor_id varchar(66) NOT NULL UNIQUE,
        name text NOT NULL,
        country integer NOT NULL,
        investor_type integer NOT NULL CHECK (investor_type BETWEEN 0 AND 2),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE wallets (
        address varchar(42) PRIMARY KEY,
        investor_uuid uuid NOT NULL REFERENCES investors (id),
        key_index integer NOT NULL UNIQUE,
        kyc_expiry timestamptz NOT NULL,
        last_action text NOT NULL CHECK (last_action IN ('REGISTER', 'REVOKE')),
        last_outbox_id uuid NOT NULL REFERENCES tx_outbox (id),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX wallets_investor_idx ON wallets (investor_uuid)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE wallets');
    await queryRunner.query('DROP TABLE investors');
  }
}
