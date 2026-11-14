import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOperationRequests1700000003000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE operation_requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        type text NOT NULL,
        params jsonb NOT NULL,
        reason_code text NOT NULL,
        evidence_hash varchar(66),
        status text NOT NULL DEFAULT 'PENDING_APPROVAL'
          CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED')),
        requested_by uuid NOT NULL REFERENCES operators (id),
        decided_by uuid REFERENCES operators (id),
        decision_note text,
        decided_at timestamptz,
        outbox_id uuid REFERENCES tx_outbox (id),
        created_at timestamptz NOT NULL DEFAULT now(),
        -- Four-eyes rule, enforced by the database as well as by the service.
        CONSTRAINT operation_requests_four_eyes CHECK (decided_by IS NULL OR decided_by <> requested_by OR status = 'APPROVED' AND decision_note = 'AUTO')
      )
    `);
    await queryRunner.query('CREATE INDEX operation_requests_status_idx ON operation_requests (status, created_at)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE operation_requests');
  }
}
