// Worker thread running the indexing passes of the stdio server (the first build and every refresh): parsing,
// writing and resolving tens of thousands of files is CPU-bound and would otherwise stall the MCP event loop
// (initialize / tools/list timeouts in Kiro, tool calls frozen for seconds during a refresh).
// Protocol (see index-host.ts): parent -> {type: 'job', id, job}; worker -> {type: 'loaded'} once, then per job
// {type: 'phase', id, phase} and finally {type: 'done', id, stats} or {type: 'error', id, message};
// {type: 'error', loaded: false} when the indexer cannot even be loaded. {type: 'close'} ends the thread when idle.

import { parentPort, workerData } from 'node:worker_threads';
import { indexPath, type KoptConfig } from '../core/config.js';
import { setCharsPerToken } from '../core/tokens.js';
import { Store } from '../store/store.js';
import { defaultModules, type IndexPhase, type IndexerModule } from './modules.js';
import type { HostJob } from './index-host.js';

const port = parentPort!;
const { config } = workerData as { config: KoptConfig };
// The parent's stdout may be the MCP channel.
console.log = console.info = console.debug = (...a: unknown[]) => console.error(...a);
setCharsPerToken(config.charsPerToken);

let indexer: IndexerModule | undefined;
let store: Store | undefined;

function openStore(): Store {
  if (!store) {
    store = Store.open(indexPath(config), { root: config.root });
    store.db.exec('PRAGMA busy_timeout=5000');
  }
  return store;
}

async function runJob(id: number, job: HostJob): Promise<void> {
  try {
    const s = openStore();
    let last = 0;
    let lastPhase = '';
    const onPhase = (p: IndexPhase) => {
      const now = Date.now();
      // phase changes at once, progress at most every 100 ms
      if (p.phase === lastPhase && now - last < 100 && !(p.total && p.done === p.total)) return;
      last = now;
      lastPhase = p.phase;
      port.postMessage({ type: 'phase', id, phase: p });
    };
    const opts = { config, paths: job.paths, onPhase, lock: job.lock };
    const stats = job.kind === 'build' ? await indexer!.indexRepo(s, opts) : await indexer!.refreshIndex(s, { ...opts, maxFiles: job.maxFiles });
    port.postMessage({ type: 'done', id, stats });
  } catch (err) {
    port.postMessage({ type: 'error', id, message: (err as Error)?.message ?? String(err) });
  }
}

try {
  indexer = await defaultModules.indexer();
  port.on('message', (m: { type: string; id: number; job: HostJob }) => {
    if (m?.type === 'job') void runJob(m.id, m.job);
    else if (m?.type === 'close') {
      // idle: give the memory back (parsers, caches); the host only asks when no job is running
      try {
        store?.close();
      } catch {
        // already closed
      }
      store = undefined;
      port.close();
    }
  });
  port.postMessage({ type: 'loaded' });
} catch (err) {
  port.postMessage({ type: 'error', loaded: false, message: (err as Error)?.message ?? String(err) });
  port.close();
}
