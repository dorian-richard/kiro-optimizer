// Local telemetry: synchronous JSONL append per UTC day, read back by `kopt stats`. Nothing is sent anywhere.
//
// Files: <userDir>/telemetry/<YYYY-MM-DD>.jsonl (kept RETAIN_DAYS days), credits cursor in credits.ts.

export { record, pruneTelemetry, telemetryDir, telemetryRepo, dayFileName, dayFiles, RETAIN_DAYS } from './record.js';
export { collectKiroCredits } from './credits.js';
export { stats } from './stats.js';
