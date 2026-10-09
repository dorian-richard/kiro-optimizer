// Centrality priors: files.rank = PageRank over the file dependency graph, symbols.rank = log in-degree.

import type { Store } from '../store/store.js';

const DAMPING = 0.85;
const ITERATIONS = 20;

/**
 * Weighted PageRank. `edges` are [src, dst, weight] over node indices 0..n-1. Dangling mass is spread
 * uniformly. Returns scores normalized to max = 1.
 */
export function pageRank(n: number, edges: Array<[number, number, number]>, iterations = ITERATIONS, damping = DAMPING): Float64Array {
  const rank = new Float64Array(n);
  if (n === 0) return rank;
  const outW = new Float64Array(n);
  for (const [s, , w] of edges) outW[s] += w;
  // CSR by destination for a cache-friendly pull iteration
  const inStart = new Int32Array(n + 1);
  for (const [, d] of edges) inStart[d + 1]++;
  for (let i = 0; i < n; i++) inStart[i + 1] += inStart[i];
  const fill = inStart.slice(0, n);
  const inSrc = new Int32Array(edges.length);
  const inW = new Float64Array(edges.length);
  for (const [s, d, w] of edges) {
    const k = fill[d]++;
    inSrc[k] = s;
    inW[k] = w;
  }
  rank.fill(1 / n);
  const next = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    let dangling = 0;
    for (let i = 0; i < n; i++) if (outW[i] === 0) dangling += rank[i];
    const base = (1 - damping) / n + (damping * dangling) / n;
    for (let d = 0; d < n; d++) {
      let sum = 0;
      for (let k = inStart[d]; k < inStart[d + 1]; k++) {
        const s = inSrc[k];
        sum += (rank[s] * inW[k]) / outW[s];
      }
      next[d] = base + damping * sum;
    }
    rank.set(next);
  }
  let max = 0;
  for (let i = 0; i < n; i++) if (rank[i] > max) max = rank[i];
  if (max > 0) for (let i = 0; i < n; i++) rank[i] /= max;
  return rank;
}

/** Recomputes files.rank and symbols.rank for the whole index. */
export function computeRanks(store: Store): { files: number; symbols: number } {
  const db = store.db;
  const files = db.prepare('SELECT id FROM files ORDER BY id').all() as Array<{ id: number }>;
  const index = new Map<number, number>();
  files.forEach((f, i) => index.set(f.id, i));
  const weights = new Map<number, number>();
  const n = files.length;
  const key = (s: number, d: number) => s * n + d;
  const addEdge = (srcId: number, dstId: number, w: number) => {
    const s = index.get(srcId);
    const d = index.get(dstId);
    if (s === undefined || d === undefined || s === d) return;
    const k = key(s, d);
    weights.set(k, (weights.get(k) ?? 0) + w);
  };
  const refEdges = db
    .prepare(
      `SELECT r.file_id AS s, t.file_id AS d, count(*) AS c
       FROM refs r JOIN symbols t ON t.id = r.to_symbol_id
       WHERE r.to_symbol_id IS NOT NULL AND r.kind <> 'import'
       GROUP BY r.file_id, t.file_id`,
    )
    .all() as Array<{ s: number; d: number; c: number }>;
  // sqrt damps chatty files: 100 calls into a helper module is not 100x more "dependency" than 1
  for (const e of refEdges) addEdge(e.s, e.d, Math.sqrt(e.c));
  const impEdges = db.prepare('SELECT file_id AS s, target_file_id AS d FROM file_imports WHERE target_file_id IS NOT NULL').all() as Array<{ s: number; d: number }>;
  for (const e of impEdges) addEdge(e.s, e.d, 1);
  const edges: Array<[number, number, number]> = [];
  for (const [k, w] of weights) edges.push([Math.floor(k / n), k % n, w]);
  const pr = pageRank(n, edges);

  const indeg = db
    .prepare('SELECT to_symbol_id AS id, count(*) AS c FROM refs WHERE to_symbol_id IS NOT NULL GROUP BY to_symbol_id')
    .all() as Array<{ id: number; c: number }>;
  let maxDeg = 0;
  for (const r of indeg) if (r.c > maxDeg) maxDeg = r.c;
  const denom = Math.log1p(maxDeg) || 1;

  store.transaction(() => {
    const updFile = db.prepare('UPDATE files SET rank = ? WHERE id = ?');
    for (let i = 0; i < n; i++) updFile.run(Math.round(pr[i] * 1e6) / 1e6, files[i].id);
    db.exec('UPDATE symbols SET rank = 0 WHERE rank <> 0');
    const updSym = db.prepare('UPDATE symbols SET rank = ? WHERE id = ?');
    for (const r of indeg) updSym.run(Math.round((Math.log1p(r.c) / denom) * 1e6) / 1e6, r.id);
  });
  return { files: n, symbols: indeg.length };
}
