// infra/repos.json: the repositories indexed centrally (one CodeBuild project each).

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export type RepoSourceType = 'GITHUB' | 'GITHUB_ENTERPRISE' | 'BITBUCKET' | 'CODECOMMIT' | 'S3';

export interface RepoSource {
  type: RepoSourceType;
  /** GITHUB / BITBUCKET: account or workspace. */
  owner?: string;
  /** GITHUB / BITBUCKET / CODECOMMIT: repository name. */
  repo?: string;
  /** GITHUB_ENTERPRISE: HTTPS clone URL. S3: s3://bucket/path/to/source.zip. */
  location?: string;
  /** Default branch to index (ignored for S3). */
  branch?: string;
}

export interface RepoEntry {
  /** Logical repo name used in S3 keys, the MCP server and telemetry ([A-Za-z0-9._-]). */
  name: string;
  source: RepoSource;
  /** Per-repo override of the webhook (default: context `webhooks`, when the source supports it). */
  webhook?: boolean;
  computeType?: 'SMALL' | 'MEDIUM' | 'LARGE';
  timeoutMinutes?: number;
}

export const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const TYPES: RepoSourceType[] = ['GITHUB', 'GITHUB_ENTERPRISE', 'BITBUCKET', 'CODECOMMIT', 'S3'];

/** Sources for which CodeBuild can create a push webhook. CodeCommit uses an EventBridge rule instead. */
export function supportsWebhook(t: RepoSourceType): boolean {
  return t === 'GITHUB' || t === 'GITHUB_ENTERPRISE' || t === 'BITBUCKET';
}

export function validateRepos(raw: unknown, origin = 'repos.json'): RepoEntry[] {
  const list = Array.isArray(raw) ? raw : (raw as { repos?: unknown })?.repos;
  if (!Array.isArray(list)) throw new Error(`${origin}: expected an array of repos (or {"repos": [...]})`);
  const seen = new Set<string>();
  return list.map((r: any, i: number) => {
    const where = `${origin}[${i}]`;
    if (!r || typeof r !== 'object') throw new Error(`${where}: expected an object`);
    if (typeof r.name !== 'string' || !REPO_NAME_RE.test(r.name)) throw new Error(`${where}: invalid name "${r.name}" (allowed: [A-Za-z0-9._-], max 100)`);
    const lname = r.name.toLowerCase();
    if (seen.has(lname)) throw new Error(`${where}: duplicate repo name "${r.name}"`);
    seen.add(lname);
    const s = r.source;
    if (!s || !TYPES.includes(s.type)) throw new Error(`${where}: source.type must be one of ${TYPES.join('|')}`);
    const need = (k: keyof RepoSource) => {
      if (typeof s[k] !== 'string' || !s[k]) throw new Error(`${where}: source.${k} is required for ${s.type}`);
    };
    switch (s.type as RepoSourceType) {
      case 'GITHUB':
      case 'BITBUCKET':
        need('owner');
        need('repo');
        break;
      case 'GITHUB_ENTERPRISE':
        need('location');
        if (!/^https:\/\//.test(s.location)) throw new Error(`${where}: source.location must be an https clone URL`);
        break;
      case 'CODECOMMIT':
        need('repo');
        break;
      case 'S3':
        need('location');
        if (!/^s3:\/\/[a-z0-9.-]{3,63}\/.+/.test(s.location)) throw new Error(`${where}: source.location must be s3://bucket/key`);
        break;
    }
    if (s.branch !== undefined && (typeof s.branch !== 'string' || !s.branch || /\s/.test(s.branch))) {
      throw new Error(`${where}: invalid branch`);
    }
    if (r.computeType !== undefined && !['SMALL', 'MEDIUM', 'LARGE'].includes(r.computeType)) {
      throw new Error(`${where}: computeType must be SMALL|MEDIUM|LARGE`);
    }
    if (r.timeoutMinutes !== undefined && !(Number.isInteger(r.timeoutMinutes) && r.timeoutMinutes >= 5 && r.timeoutMinutes <= 2160)) {
      throw new Error(`${where}: timeoutMinutes must be an integer in [5, 2160]`);
    }
    if (r.webhook !== undefined && typeof r.webhook !== 'boolean') throw new Error(`${where}: webhook must be a boolean`);
    return {
      name: r.name,
      source: { ...s, branch: s.type === 'S3' ? undefined : s.branch ?? 'main' },
      webhook: r.webhook,
      computeType: r.computeType,
      timeoutMinutes: r.timeoutMinutes,
    } as RepoEntry;
  });
}

/** Load and validate repos.json (path relative to the infra/ directory). A missing file means no repos. */
export function loadRepos(file: string, baseDir: string): RepoEntry[] {
  const path = isAbsolute(file) ? file : resolve(baseDir, file);
  if (!existsSync(path)) return [];
  return validateRepos(JSON.parse(readFileSync(path, 'utf8')), file);
}
