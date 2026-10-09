// Token estimation and budget fitting.
//
// Kiro bills credits, not tokens, and exposes no tokenizer. Recent Claude tokenizers (4.7+) produce
// ~30% more tokens than older ones; CodeGraph measured ~2.3 chars/token on line-numbered code and
// tiktoken o200k gives 3.9-4.8 chars/token. We use a conservative 3.0 chars/token so that budgets are
// respected in practice. Override with KOPT_CHARS_PER_TOKEN for calibration (see bench/).

let charsPerToken = Number(process.env.KOPT_CHARS_PER_TOKEN) || 3.0;

export function setCharsPerToken(value: number): void {
  if (value > 0) charsPerToken = value;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / charsPerToken);
}

export function tokensToChars(tokens: number): number {
  return Math.floor(tokens * charsPerToken);
}

/**
 * Keep whole lines from the head of `text` until the budget is reached.
 * Appends a one-line marker saying how many lines were cut.
 */
export function truncateLines(text: string, maxTokens: number, marker = (n: number) => `… ${n} more lines`): {
  text: string;
  truncated: boolean;
} {
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false };
  const lines = text.split('\n');
  const maxChars = tokensToChars(maxTokens);
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    // reserve room for the marker line
    if (used + line.length + 1 > maxChars - 24) break;
    out.push(line);
    used += line.length + 1;
  }
  const cut = lines.length - out.length;
  out.push(marker(cut));
  return { text: out.join('\n'), truncated: true };
}

/**
 * Keep head and tail lines (useful for logs where the end carries the verdict).
 */
export function truncateMiddle(text: string, maxTokens: number, headRatio = 0.4): { text: string; truncated: boolean } {
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false };
  const lines = text.split('\n');
  const maxChars = tokensToChars(maxTokens) - 32;
  const headBudget = Math.floor(maxChars * headRatio);
  const tailBudget = maxChars - headBudget;
  const head: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > headBudget) break;
    head.push(line);
    used += line.length + 1;
  }
  const tail: string[] = [];
  used = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    const line = lines[i];
    if (used + line.length + 1 > tailBudget) break;
    tail.unshift(line);
    used += line.length + 1;
  }
  const cut = lines.length - head.length - tail.length;
  return { text: [...head, `… ${cut} lines omitted …`, ...tail].join('\n'), truncated: true };
}

/**
 * Greedily pack ordered sections into a budget. Sections that do not fit are dropped (not cut),
 * except the first one which is line-truncated so the answer is never empty.
 */
export function packSections(sections: string[], maxTokens: number, separator = '\n'): {
  text: string;
  tokens: number;
  dropped: number;
} {
  const kept: string[] = [];
  let used = 0;
  let dropped = 0;
  const sepTokens = estimateTokens(separator);
  for (const s of sections) {
    const t = estimateTokens(s) + (kept.length ? sepTokens : 0);
    if (used + t <= maxTokens) {
      kept.push(s);
      used += t;
    } else if (kept.length === 0) {
      const cut = truncateLines(s, maxTokens).text;
      kept.push(cut);
      used += estimateTokens(cut);
    } else {
      dropped++;
    }
  }
  const text = kept.join(separator);
  return { text, tokens: estimateTokens(text), dropped };
}
