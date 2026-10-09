// Standalone entry: `npm run bench -- <args>` (same as `kopt bench <args>`).
import { runBenchCli } from './index.js';

runBenchCli(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`kopt bench: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
