// npm / yarn / pnpm / bun (install, ci, add, run <script>). Package-manager chatter (deprecations, funding,
// audit advice, progress, resolution steps) is reduced to one summary line; npm error blocks are condensed;
// a script's own output goes through the generic filter (test/lint/tsc output is claimed by its own filter
// first, because this filter only matches with a low score).

import { estimateTokens } from '../../core/tokens.js';
import { runs } from '../command.js';
import { fit, joinWithin, plural, repeatCount, type Filter, type FilterInput } from './common.js';
import { genericCompress } from './generic.js';

const PM = ['npm', 'yarn', 'pnpm', 'bun', 'npx'];

const DEPRECATED_RE = /^(?:npm (?:WARN|warn) deprecated|\s*WARN\s+(?:\d+ )?deprecated|warning .*deprecated)/;
const NPM_WARN_RE = /^npm (?:WARN|warn) |^\s*WARN\s{1,2}\S|^warning /;
const NPM_ERR_RE = /^npm (?:ERR!|error)(?: (.*))?$/;
const NPM_ERR_NOISE_RE =
  /^(?:path|workspace|location|cwd|errno|A complete log of this run|Log files were not written|This is probably not a problem with npm|\S*\.npm[\\/]_logs|Did you mean one of these|\s*$)/;
const SUMMARY_RE =
  /^(?:added|removed|changed|up to date|audited)\b.*(?:packages?|in [\d.]+m?s)|^(?:✨\s+)?Done in [\d.]+m?s\.?$|^Packages: [+-]\d+|^Already up to date$|^Lockfile is up to date/;
const AUDIT_RE = /^(?:found )?\d+ (?:(?:low|moderate|high|critical) )?(?:severity )?vulnerabilit(?:y|ies)|^\d+ vulnerabilities \(/;
const DROP_RE =
  /packages? (?:is|are) looking for funding|^\s*run `npm fund` for details|^To address (?:all )?issues|^\s*npm audit fix|^Run `npm audit` for details|^Some issues need review|^success |^\[\d\/\d\] |^info |^Progress: resolved|^[+-]{3,}$|^(?:dependencies|devDependencies|optionalDependencies|peerDependencies):$|^[+-] @?[\w./-]+ \S*\d\S*(?: \(.+\))?$|^(?:Resolving|Downloading|Fetching|Linking|Building) (?:packages|dependencies)|^bun install v|^yarn install v|^npm notice/;
const BANNER_RE = /^> \S+@\S+ \S+/;
const YARN_BERRY_RE = /^➤ YN(\d{4}): (.*)$/;

function compressNpm(inp: FilterInput): string | undefined {
  const { lines, exitCode, maxTokens } = inp;
  const yarn = runs(inp.command, ['yarn']);
  let deprecated = 0;
  let warns = 0;
  const summary: string[] = [];
  const errors: string[] = [];
  const script: string[] = [];
  const commands: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if (DEPRECATED_RE.test(line)) deprecated += repeatCount(line);
    else if ((m = NPM_ERR_RE.exec(line))) {
      const t = (m[1] ?? '').trim();
      if (!NPM_ERR_NOISE_RE.test(t) && !errors.includes(t)) errors.push(t);
    } else if (/ERR_PNPM_\w+/.test(line) || (yarn && /^error /.test(line))) {
      if (!errors.includes(line.trim())) errors.push(line.trim());
    } else if (NPM_WARN_RE.test(line)) warns += repeatCount(line);
    else if ((m = YARN_BERRY_RE.exec(line))) {
      if (/Done|Completed|Failed with errors/.test(m[2]) && /Done (?:with warnings )?in|Failed/.test(m[2])) summary.push(m[2].replace(/^[└·\s]+/, ''));
      else if (m[1] !== '0000') {
        if (/error|fail/i.test(m[2])) errors.push(`YN${m[1]}: ${m[2]}`);
        else warns++;
      }
    } else if (SUMMARY_RE.test(line) || AUDIT_RE.test(line)) {
      if (!summary.includes(line.trim())) summary.push(line.trim());
    } else if (DROP_RE.test(line)) continue;
    else if (BANNER_RE.test(line)) {
      // `> app@1.0.0 build` is followed by `> <script command>`: keep the command as context
      const next = lines[i + 1];
      if (next && /^> /.test(next) && !BANNER_RE.test(next)) {
        commands.push(next.trim());
        i++;
      }
    } else script.push(line);
  }
  const parts = [...summary];
  if (deprecated) parts.push(plural(deprecated, 'deprecation warning'));
  if (warns) parts.push(plural(warns, 'warning'));
  const head: string[] = [];
  if (commands.length) head.push(joinWithin(commands, 200, ' · '));
  if (parts.length) head.push(parts.join(' · '));
  const errText = errors.length ? `npm error: ${errors.slice(0, 12).join('\n  ')}` : '';
  const fixed = [head.join('\n'), errText].filter(Boolean).join('\n');
  const scriptLines = script.filter((l, idx) => l.trim() || (idx > 0 && script[idx - 1].trim()));
  if (!scriptLines.some((l) => l.trim())) return fit(fixed || (exitCode === 0 ? 'ok' : `exit ${exitCode}`), maxTokens);
  const budget = Math.max(40, maxTokens - estimateTokens(fixed) - 2);
  const body = genericCompress(scriptLines, exitCode, budget);
  return fit([head.join('\n'), body, errText].filter(Boolean).join('\n'), maxTokens);
}

export const npm: Filter = {
  name: 'npm',
  match(cmd, sample) {
    if (runs(cmd, PM)) return 40;
    if (/^npm (?:ERR!|error|WARN|warn) |^added \d+ packages?|^➤ YN0000|^Packages: \+\d+/m.test(sample)) return 38;
    return 0;
  },
  compress: compressNpm,
};
