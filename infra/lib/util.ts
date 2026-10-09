import * as logs from 'aws-cdk-lib/aws-logs';

const RETENTIONS = Object.values(logs.RetentionDays)
  .filter((v): v is number => typeof v === 'number' && v > 0 && v !== logs.RetentionDays.INFINITE)
  .sort((a, b) => a - b);

/** Smallest CloudWatch Logs retention >= `days` (the API only accepts a fixed set of values). */
export function retentionDays(days: number): logs.RetentionDays {
  return (RETENTIONS.find((r) => r >= days) ?? RETENTIONS[RETENTIONS.length - 1]) as logs.RetentionDays;
}
