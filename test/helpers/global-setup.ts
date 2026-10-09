import { rmSync } from 'node:fs';

/** Removes the per-run sandbox created by vitest.config.ts (temp kopt cache / ~/.kopt / ~/.kiro stand-ins). */
export default function setup(): () => void {
  return () => {
    const dir = process.env.KOPT_VITEST_SANDBOX;
    if (!dir) return;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // best effort: the OS temp dir is cleaned eventually
    }
  };
}
