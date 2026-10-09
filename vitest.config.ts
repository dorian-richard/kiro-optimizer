import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Every test run gets its own throwaway user state, so no test (or CLI/MCP subprocess spawned by a test with
// `...process.env`) can ever write into the developer's real kopt cache, ~/.kopt, ~/.kiro or Kiro user settings.
// Individual tests still override these with their own temp dirs when they need to.
const sandbox = process.env.KOPT_VITEST_SANDBOX || mkdtempSync(join(tmpdir(), 'kopt-vitest-'));
process.env.KOPT_VITEST_SANDBOX = sandbox;

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    pool: 'forks',
    globalSetup: ['test/helpers/global-setup.ts'],
    env: {
      KOPT_VITEST_SANDBOX: sandbox,
      KOPT_CACHE_DIR: join(sandbox, 'cache'),
      KOPT_HOME: join(sandbox, 'kopt-home'),
      KOPT_KIRO_HOME: join(sandbox, 'kiro-home'),
      KOPT_KIRO_USER_SETTINGS: join(sandbox, 'kiro-user', 'settings.json'),
    },
  },
});
