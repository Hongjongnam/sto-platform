import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLedger1700000004000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE chain_events (
        id bigserial PRIMARY KEY,
        tx_hash varchar(66) NOT NULL,
        log_index integer NOT NULL,
        block_number bigint NOT NULL,
        contract text NOT NULL,
        name text NOT NULL,
        args jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tx_hash, log_index)
      )
    `);
    await queryRunner.query('CREATE INDEX chain_events_order_idx ON chain_events (block_number, log_index)');
    await queryRunner.query('CREATE INDEX chain_events_name_idx ON chain_events (name, block_number)');
    await queryRunner.query(`
      CREATE TABLE indexer_cursor (
        id integer PRIMARY KEY CHECK (id = 1),
        last_block bigint NOT NULL
      )
    `);
    await queryRunner.query(`
      CREATE TABLE holdings (
        wallet varchar(42) PRIMARY KEY,
        balance numeric(78, 0) NOT NULL DEFAULT 0,
        frozen numeric(78, 0) NOT NULL DEFAULT 0,
        address_frozen boolean NOT NULL DEFAULT false,
        updated_block bigint NOT NULL
      )
    `);
    await queryRunner.query(`
      CREATE TABLE token_state (
        id integer PRIMARY KEY CHECK (id = 1),
        total_supply numeric(78, 0) NOT NULL DEFAULT 0,
        registered_supply numeric(78, 0) NOT NULL DEFAULT 0,
        paused boolean NOT NULL DEFAULT false,
        updated_block bigint NOT NULL DEFAULT 0
      )
    `);
    await queryRunner.query('INSERT INTO token_state (id) VALUES (1)');
    await queryRunner.query(`
      CREATE TABLE recon_reports (
        id bigserial PRIMARY KEY,
        block_number bigint NOT NULL,
        ok boolean NOT NULL,
        wallets_checked integer NOT NULL,
        mismatches jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['recon_reports', 'token_state', 'holdings', 'indexer_cursor', 'chain_events']) {
      await queryRunner.query(`DROP TABLE ${table}`);
    }
  }
}
