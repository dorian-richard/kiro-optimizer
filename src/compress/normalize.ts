// Terminal-output normalization. The result is what we store, what kopt_expand serves and what we count as
// the honest baseline: the text a human would see in the terminal, minus pure noise (progress bars,
// spinners, transfer chatter) which no model needs.

// CSI, OSC, DCS/PM/APC strings, 2-char escapes, 8-bit CSI.
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g;
// Cursor up / previous line: the text that follows redraws lines already printed (rich consoles).
const CURSOR_UP_RE = /\x1b\[(\d*)[AF]/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const HAS_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export function stripAnsi(s: string): string {
  return s.includes('\x1b') || s.includes('\x9b') ? s.replace(ANSI_RE, '') : s;
}

const SPINNER_RE = /^\s*(?:[⠀-⣿]|[|/\\-]\s*$)/;
const BAR_GLYPHS_RE = /[█-▏░-▓■━╸-╻]{3,}/;
const ASCII_BAR_RE = /[[<|][=#>\-.\s*]{6,}[\]>|]/;
const BAR_NUMBERS_RE = /\d{1,3}(?:\.\d+)?\s?%|\d+(?:\.\d+)?\s?\/\s?\d+(?:\.\d+)?|\beta\b|[kKMG]i?B\/s/;
const DOWNLOAD_RE =
  /^\s*(?:\[INFO\]\s+)?(?:Downloading|Downloaded|Download)(?: from \S+)?:?\s+(?:https?:\/\/|\S+\.(?:jar|pom|whl|tar\.gz|tgz|zip|egg)\b)|^\s*(?:\[INFO\]\s+)?Progress \(\d+\):|^npm (?:sill|timing|http fetch)\b/;

/** Pure noise: spinner frames, progress bars, artifact download chatter. */
export function isNoiseLine(line: string): boolean {
  if (!line) return false;
  if (SPINNER_RE.test(line)) return true;
  if ((BAR_GLYPHS_RE.test(line) || ASCII_BAR_RE.test(line)) && BAR_NUMBERS_RE.test(line)) return true;
  return DOWNLOAD_RE.test(line);
}

/** Final visible state of a line rewritten with carriage returns. */
function resolveCarriageReturns(line: string): string {
  const parts = line.split('\r');
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i].trim()) return parts[i];
  return '';
}

function applyBackspaces(line: string): string {
  const out: string[] = [];
  for (const ch of line) {
    if (ch === '\b') out.pop();
    else out.push(ch);
  }
  return out.join('');
}

/**
 * Strip ANSI escapes, resolve `\r` progress redraws and cursor-up repaints (keep final state), drop
 * progress/spinner/download lines, collapse runs of identical lines into `line (xN)` and blank runs into one.
 * Idempotent.
 */
export function normalizeOutput(raw: string): string {
  if (!raw) return '';
  // Byte order marks (Windows PowerShell / .NET writers) are invisible noise wherever they appear.
  if (raw.includes('\uFEFF')) raw = raw.replace(/\uFEFF/g, '');
  let src = raw.includes('\r\n') ? raw.replace(/\r\n/g, '\n').split('\n') : raw.split('\n');
  if (raw.includes('#< CLIXML') || raw.includes('<Objs Version=')) src = decodeClixml(src);
  // Keep noise lines in `screen` until the end so cursor-up counts stay aligned with what was printed.
  const screen: string[] = [];
  for (let line of src) {
    if (line.includes('\x1b')) {
      let up = 0;
      line = line.replace(CURSOR_UP_RE, (_m, n: string) => {
        up += n ? Number(n) : 1;
        return '';
      });
      if (up > 0) screen.splice(Math.max(0, screen.length - up));
      line = line.replace(ANSI_RE, '');
    } else if (line.includes('\x9b')) {
      line = line.replace(ANSI_RE, '');
    }
    if (line.includes('\r')) line = resolveCarriageReturns(line);
    if (line.includes('\b')) line = applyBackspaces(line);
    if (HAS_CONTROL_RE.test(line)) line = line.replace(CONTROL_RE, '');
    screen.push(line.trimEnd());
  }
  const lines = screen.some((l) => l === 'Line |' || l.includes('FullyQualifiedErrorId')) ? stripPowerShellErrorNoise(screen) : screen;
  return collapseRepeats(lines.filter((l) => !isNoiseLine(l))).join('\n');
}

const PS_AT_RE = /^At (?:line:\d+|.+:\d+) char:\d+$/;
const PS_SOURCE_RE = /^\+ /;
const PS_INFO_RE = /^\s+\+ (?:CategoryInfo|FullyQualifiedErrorId)\s*: /;
const PS_FQID_RE = /^\s+\+ FullyQualifiedErrorId\s*: (\S+)/;
const PS_CONCISE_ROW_RE = /^\s*\d*\s*\|/;

/**
 * PowerShell error decorations -> one line per error (kopt_run uses PowerShell on Windows).
 * Windows PowerShell 5.1 (`msg` / `At line:2 char:1` / `+ source` / `+ ~~~` / `+ CategoryInfo` /
 * `+ FullyQualifiedErrorId`) keeps `msg`; for a native command's stderr line (NativeCommandError, how 5.1 wraps
 * stderr when its own stderr is a pipe) the `node : ` prefix is dropped too. pwsh 7 ConciseView
 * (`name:` / `Line |` / `   2 |  source` / `     |  ~~~` / `     | message`) becomes `name: message`.
 */
export function stripPowerShellErrorNoise(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (out.length && PS_AT_RE.test(l)) {
      let j = i + 1;
      while (j < lines.length && j < i + 4 && PS_SOURCE_RE.test(lines[j])) j++;
      let fqid: string | undefined;
      let k = j;
      while (k < lines.length && k < j + 3 && PS_INFO_RE.test(lines[k])) {
        fqid = PS_FQID_RE.exec(lines[k])?.[1] ?? fqid;
        k++;
      }
      if (fqid) {
        if (fqid.startsWith('NativeCommandError')) out[out.length - 1] = out[out.length - 1].replace(/^(?:[A-Za-z]:)?[^:]*? : /, '');
        i = k < lines.length && !lines[k].trim() ? k : k - 1;
        continue;
      }
    }
    if (l === 'Line |' && out.length && /:$/.test(out[out.length - 1])) {
      const message: string[] = [];
      let j = i + 1;
      for (; j < lines.length && PS_CONCISE_ROW_RE.test(lines[j]); j++) {
        if (/^\s*\d+\s*\|/.test(lines[j])) continue; // the source line
        const body = lines[j].replace(PS_CONCISE_ROW_RE, '').trim();
        if (body && !/^~+$/.test(body)) message.push(body);
      }
      if (message.length) {
        out[out.length - 1] = `${out[out.length - 1]} ${message.join(' ')}`;
        i = j - 1;
        continue;
      }
    }
    out.push(l);
  }
  return out;
}

const CLIXML_OBJS_RE = /^<Objs Version="[^"]*" xmlns="http:\/\/schemas\.microsoft\.com\/powershell\/2004\/04">/;
const CLIXML_ERROR_RE = /<S S="(?:Error|Warning)">([\s\S]*?)<\/S>/g;

function unescapeClixml(s: string): string {
  return s
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Windows PowerShell can serialize its error / progress streams as CLIXML on stderr (`#< CLIXML` followed by
 * one `<Objs ...>` line). Keep the error and warning text, drop progress records and the XML.
 */
export function decodeClixml(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === '#< CLIXML') continue;
    if (!CLIXML_OBJS_RE.test(line)) {
      out.push(line);
      continue;
    }
    for (const m of line.matchAll(CLIXML_ERROR_RE)) {
      for (const l of unescapeClixml(m[1]).replace(/\r\n?/g, '\n').split('\n')) if (l.trim()) out.push(l.trimEnd());
    }
  }
  return out;
}

const REPEAT_SUFFIX_RE = /^(.*) \(x(\d+)\)$/;

/** `a a a b` -> `a (x3) b`; blank runs -> one blank; trims leading/trailing blank lines. Idempotent. */
export function collapseRepeats(lines: string[]): string[] {
  const out: string[] = [];
  let prev: string | undefined;
  let count = 0;
  const flush = () => {
    if (prev === undefined) return;
    out.push(count > 1 ? `${prev} (x${count})` : prev);
    prev = undefined;
    count = 0;
  };
  for (const line of lines) {
    if (line === '') {
      flush();
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    // Re-normalizing already collapsed text must not change it.
    const m = REPEAT_SUFFIX_RE.exec(line);
    const base = m ? m[1] : line;
    const n = m ? Number(m[2]) : 1;
    if (prev === base) count += n;
    else {
      flush();
      prev = base;
      count = n;
    }
  }
  flush();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}
