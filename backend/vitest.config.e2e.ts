import { defineConfig } from 'vitest/config';

// Integration tests run against a real PostgreSQL (infra/postgres) and a local in-memory
// chain that the global setup starts and deploys to.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['./test/setup/global-setup.ts'],
    // One chain and one database are shared, so files run one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      PORT: '4781',
      DATABASE_URL: 'postgres://sto:sto@127.0.0.1:54320/sto_test',
      RPC_URL: 'http://127.0.0.1:8546',
      DEPLOYMENT_FILE: '../contracts/deployments/local.json',
      CHAIN_MNEMONIC: 'test test test test test test test test test test test junk',
      JWT_SECRET: 'integration-test-secret-integration-test-secret',
      // Tests drive the worker explicitly.
      OUTBOX_WORKER: 'off',
      INDEXER_WORKER: 'off',
    },
  },
});
