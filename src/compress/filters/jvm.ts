// JVM helpers shared by the maven and gradle filters.

import { trimStack } from './common.js';

/**
 * Exception text + frames -> message lines (capped) and up to 3 in-repo frames per stack (`Caused by:` chains
 * keep their own frames). Gradle's `app//` / `java.base@17/` frame prefixes are stripped.
 */
export function digestJavaTrace(body: string[], maxMessageLines = 8): { lines: string[]; key: string } {
  const cleaned = body.filter((l) => l.trim()).map((l) => l.replace(/^(\s*at\s+)app\/\//, '$1'));
  const trimmed = trimStack(cleaned, 3, false);
  const out: string[] = [];
  let msgRun = 0;
  for (const l of trimmed) {
    const isFrame = /^\s*at\s/.test(l);
    if (isFrame) {
      msgRun = 0;
      out.push(`  ${l.trim()}`);
      continue;
    }
    if (/^\s*Caused by:/.test(l)) msgRun = 0;
    msgRun++;
    if (msgRun <= maxMessageLines) out.push(`  ${l.trim()}`);
    else if (msgRun === maxMessageLines + 1) out.push('  …');
  }
  const message = cleaned.filter((l) => !/^\s*at\s/.test(l)).slice(0, 3).join('\n');
  const firstFrame = trimmed.find((l) => /^\s*at\s/.test(l)) ?? '';
  return { lines: out, key: `${message}|${firstFrame.trim()}` };
}

export const JAVAC_RE = /^(\S.*?\.(?:java|groovy|scala)):(\d+): (error|warning): (.*)$/;
export const KOTLIN_RE = /^([ew]): (?:file:\/\/)?(\S.*?\.kts?):(\d+):(\d+):? (.*)$/;
export const KOTLIN_OLD_RE = /^([ew]): (\S.*?\.kts?): \((\d+), (\d+)\): (.*)$/;
export const JAVAC_EXTRA_RE = /^\s+(symbol|location|required|found|reason|where)\b:?/;
