import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Every test run gets its own throwaway user state, so no test (or CLI/MCP subprocess spawned by a test with
// `...process.env`) can ever write into the developer's real kopt cache, ~/.kopt, ~/.kiro or Kiro user settings.
// Individual tests still override these with their own temp dirs when they need to.
const sandbox = process.env.KOPT_VITEST_SANDBOX || mkdtempSync(join(tmpdir(), 'kopt-vitest-'));
process.env.KOPT_VITEST_SANDBOX = sandbox;
const home = join(sandbox, 'home');
mkdirSync(home, { recursive: true });

// The developer's kiro-cli may be logged in (and spend real credits): the tests never see it. HOME points to the
// sandbox (logged out), and `kopt bench ab` talks to the simulator. The one test that runs the real binary for
// offline commands (agent validate / list, mcp list in a temporary HOME) is opt-in: KOPT_TEST_REAL_KIRO_CLI=1 hands
// it the binary in KOPT_VITEST_REAL_KIRO_CLI. By default no test starts the real kiro-cli: some of its commands can
// start a browser login on their own, and automated calls on a developer's account can trip Kiro's anti-abuse checks.
const realChat =
  process.env.KOPT_TEST_REAL_KIRO_CLI === '1'
    ? [join(homedir(), '.local', 'bin', 'kiro-cli-chat'), '/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli-chat'].find((p) => existsSync(p))
    : undefined;

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
      HOME: home,
      USERPROFILE: home,
      KIRO_HOME: join(home, '.kiro'),
      KIRO_CLI: resolve(__dirname, 'bench', 'ab', 'fake-kiro-cli.mjs'),
      KIRO_API_KEY: '',
      ...(realChat ? { KOPT_VITEST_REAL_KIRO_CLI: realChat } : {}),
    },
  },
});
