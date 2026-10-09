// Worker thread running the initial indexRepo() for the stdio server: parsing tens of thousands of files is
// CPU-bound and would otherwise stall the MCP event loop (initialize / tools/list timeouts in Kiro).
// Talks to the parent with {type: 'loaded' | 'progress' | 'done' | 'error'} messages.

import { parentPort, workerData } from 'node:worker_threads';
import { indexPath, type KoptConfig } from '../core/config.js';
import { setCharsPerToken } from '../core/tokens.js';
import { Store } from '../store/store.js';
import { defaultModules } from './modules.js';

const port = parentPort!;
const { config } = workerData as { config: KoptConfig };
// The parent's stdout may be the MCP channel.
console.log = console.info = console.debug = (...a: unknown[]) => console.error(...a);
setCharsPerToken(config.charsPerToken);

let loaded = false;
let store: Store | undefined;
try {
  const { indexRepo } = await defaultModules.indexer();
  loaded = true;
  port.postMessage({ type: 'loaded' });
  store = Store.open(indexPath(config), { root: config.root });
  store.db.exec('PRAGMA busy_timeout=5000');
  let last = 0;
  const stats = await indexRepo(store, {
    config,
    onProgress: (done, total) => {
      const now = Date.now();
      if (now - last < 100 && done < total) return;
      last = now;
      port.postMessage({ type: 'progress', done, total });
    },
  });
  port.postMessage({ type: 'done', stats });
} catch (err) {
  port.postMessage({ type: 'error', loaded, message: (err as Error)?.message ?? String(err) });
} finally {
  try {
    store?.close();
  } catch {
    // ignore
  }
}
