import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import pg from 'pg';

const CONTRACTS_DIR = join(import.meta.dirname, '..', '..', '..', 'contracts');
const RPC_URL = 'http://127.0.0.1:8546';
const ADMIN_DATABASE_URL = 'postgres://sto:sto@127.0.0.1:54320/postgres';
const TEST_DATABASE = 'sto_test';

let node: ChildProcess | undefined;

async function rpcReady(): Promise<boolean> {
  try {
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Starts a fresh in-memory chain, deploys the contracts to it and recreates the test
 * database. Requires infra/postgres to be running.
 */
export async function setup(): Promise<void> {
  if (await rpcReady()) throw new Error(`something is already listening on ${RPC_URL}; stop it before running the tests`);

  node = spawn('npx', ['hardhat', 'node', '--port', '8546'], { cwd: CONTRACTS_DIR, stdio: 'ignore' });
  const deadline = Date.now() + 60_000;
  while (!(await rpcReady())) {
    if (Date.now() > deadline) throw new Error('the local chain did not start');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  for (const script of ['scripts/deploy.ts', 'scripts/accept-handover.ts']) {
    execFileSync('npx', ['hardhat', 'run', script, '--network', 'local'], { cwd: CONTRACTS_DIR, stdio: 'ignore' });
  }

  const client = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
  await client.query(`CREATE DATABASE ${TEST_DATABASE}`);
  await client.end();
}

export async function teardown(): Promise<void> {
  node?.kill('SIGTERM');
}
