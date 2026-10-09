// worker_threads entry: runs prepareFile (read + parse + extract) off the main thread.
// Every job gets exactly one answer ({id, r} or {id, error}); the pool re-runs failed jobs in-process.
import { parentPort } from 'node:worker_threads';
import { prepareFile, type PrepJob, type Prepared } from './prepare.js';

interface Msg {
  id: number;
  job: PrepJob;
}

const port = parentPort;
if (port) {
  const fail = (id: number, err: unknown) => {
    try {
      port.postMessage({ id, error: String((err as Error)?.message ?? err) });
    } catch {
      /* port closed: the pool is shutting down */
    }
  };
  port.on('message', (msg: Msg) => {
    prepareFile(msg.job).then(
      (r: Prepared) => {
        try {
          port.postMessage({ id: msg.id, r });
        } catch (err) {
          fail(msg.id, err);
        }
      },
      (err: unknown) => fail(msg.id, err),
    );
  });
}
