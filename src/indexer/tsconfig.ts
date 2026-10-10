// tsconfig.json / jsconfig.json `compilerOptions.paths` and `baseUrl`, for import resolution
// (`import { x } from "@utils"` -> packages/foo/src/utils/index.ts). Read-only, cached per directory; only
// relative `extends` are followed (a package preset never holds project-specific aliases).

import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

interface PathRule {
  prefix: string;
  suffix: string;
  wildcard: boolean;
  targets: string[];
}

/** Effective aliases for the files under one tsconfig. Directories are repo-relative ('' = root). */
export interface TsPaths {
  /** Directory `paths` targets are relative to (baseUrl, else the directory of the config that sets paths). */
  pathsBase: string;
  rules: PathRule[];
  /** `baseUrl` directory, when set: non-relative specifiers may also resolve from there. */
  baseUrl?: string;
}

interface RawConfig {
  dir: string;
  baseUrl?: string;
  /** Directory of the config that declared `paths` + the raw map. */
  paths?: { dir: string; map: Record<string, string[]> };
}

const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json'];
const MAX_EXTENDS = 8;

/** JSON with comments and trailing commas (the tsconfig dialect). */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1').replace(/^﻿/, ''));
}

function compileRules(map: Record<string, string[]>): PathRule[] {
  const rules: PathRule[] = [];
  for (const [pattern, targets] of Object.entries(map)) {
    if (!Array.isArray(targets)) continue;
    const star = pattern.indexOf('*');
    const list = targets.filter((t): t is string => typeof t === 'string');
    if (!list.length) continue;
    if (star < 0) rules.push({ prefix: pattern, suffix: '', wildcard: false, targets: list });
    else rules.push({ prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1), wildcard: true, targets: list });
  }
  // longest prefix first, as TypeScript does
  return rules.sort((a, b) => b.prefix.length - a.prefix.length);
}

export class TsConfigs {
  private readonly byDir = new Map<string, TsPaths | null>();
  private readonly files = new Map<string, RawConfig | null>();

  constructor(private readonly root: string) {}

  /** Aliases that apply to a file in `dir` (nearest config up to the repo root), or null. */
  forDir(dir: string): TsPaths | null {
    const cached = this.byDir.get(dir);
    if (cached !== undefined) return cached;
    let res: TsPaths | null = null;
    let found = false;
    for (const name of CONFIG_NAMES) {
      const cfg = this.load(dir ? `${dir}/${name}` : name, 0);
      if (cfg) {
        found = true;
        res = cfg.paths || cfg.baseUrl !== undefined
          ? {
              pathsBase: cfg.baseUrl ?? cfg.paths?.dir ?? cfg.dir,
              rules: cfg.paths ? compileRules(cfg.paths.map) : [],
              ...(cfg.baseUrl !== undefined ? { baseUrl: cfg.baseUrl } : {}),
            }
          : null;
        break;
      }
    }
    if (!found && dir) {
      const slash = dir.lastIndexOf('/');
      res = this.forDir(slash < 0 ? '' : dir.slice(0, slash));
    }
    this.byDir.set(dir, res);
    return res;
  }

  /** Candidate repo-relative paths (without extension handling) for a non-relative specifier. */
  candidates(spec: string, cfg: TsPaths): string[] {
    const out: string[] = [];
    for (const r of cfg.rules) {
      let captured: string;
      if (!r.wildcard) {
        if (spec !== r.prefix) continue;
        captured = '';
      } else {
        if (!spec.startsWith(r.prefix) || !spec.endsWith(r.suffix) || spec.length < r.prefix.length + r.suffix.length) continue;
        captured = spec.slice(r.prefix.length, spec.length - r.suffix.length);
      }
      for (const t of r.targets) out.push(posix.normalize(posix.join(cfg.pathsBase, t.replace('*', captured))));
      break; // the longest matching pattern wins
    }
    if (cfg.baseUrl !== undefined) out.push(posix.normalize(posix.join(cfg.baseUrl, spec)));
    return out.filter((p) => p !== '..' && !p.startsWith('../') && !p.startsWith('/'));
  }

  private load(rel: string, depth: number): RawConfig | null {
    const cached = this.files.get(rel);
    if (cached !== undefined) return cached;
    this.files.set(rel, null); // cycle guard
    let json: Record<string, unknown> | undefined;
    try {
      json = parseJsonc(readFileSync(join(this.root, rel), 'utf8')) as Record<string, unknown>;
    } catch {
      json = undefined;
    }
    if (!json || typeof json !== 'object') return null;
    const dir = posix.dirname(rel) === '.' ? '' : posix.dirname(rel);
    const cfg: RawConfig = { dir };
    // parents first, then own options override
    const ext = json.extends;
    const parents = typeof ext === 'string' ? [ext] : Array.isArray(ext) ? ext.filter((e): e is string => typeof e === 'string') : [];
    if (depth < MAX_EXTENDS) {
      for (const p of parents) {
        if (!p.startsWith('.')) continue;
        let target = posix.normalize(posix.join(dir, p));
        if (!target.endsWith('.json')) target += '.json';
        if (target.startsWith('../')) continue;
        const parent = this.load(target, depth + 1);
        if (!parent) continue;
        if (parent.baseUrl !== undefined) cfg.baseUrl = parent.baseUrl;
        if (parent.paths) cfg.paths = parent.paths;
      }
    }
    const co = json.compilerOptions as Record<string, unknown> | undefined;
    if (co && typeof co === 'object') {
      if (typeof co.baseUrl === 'string') cfg.baseUrl = posix.normalize(posix.join(dir, co.baseUrl)).replace(/^\.\/?$/, '').replace(/\/$/, '');
      if (co.paths && typeof co.paths === 'object') cfg.paths = { dir, map: co.paths as Record<string, string[]> };
    }
    this.files.set(rel, cfg);
    return cfg;
  }
}
