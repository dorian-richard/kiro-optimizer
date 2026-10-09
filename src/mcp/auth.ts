// OAuth 2.1 resource-server side for the HTTP MCP server: bearer JWT validation (jose + remote JWKS),
// RFC 9728 protected-resource metadata, RFC 6750 challenges, and group -> repo authorization.

import { readFileSync, statSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

export interface AuthOptions {
  /** Expected `iss`, exact match (e.g. https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_AbC). */
  issuer: string;
  /** Accepted `aud` value(s). */
  audience?: string | string[];
  /** Accepted Cognito access-token `client_id` value(s) (Cognito access tokens carry no `aud`). */
  clientId?: string | string[];
  /** Default: `<issuer>/.well-known/jwks.json` (Cognito layout). */
  jwksUrl?: string;
  /** All of these must be granted via `scope` (space-separated) or `scp`. */
  requiredScopes?: string[];
  /**
   * Scopes required on the telemetry route instead of `requiredScopes` (e.g. `kopt/telemetry`), so a token kept on
   * a developer machine for telemetry cannot query code. Unset or empty: `requiredScopes` applies to every route.
   */
  telemetryScopes?: string[];
  /** Public base URL of this server (protected-resource metadata + WWW-Authenticate). */
  resourceUrl: string;
  /** Group -> repos (`{"payments": ["billing-api"], "admins": ["*"], "*": ["docs"]}`) or a JSON file path. */
  reposAcl?: string | Record<string, string[]>;
  /**
   * 'self': advertise this server as the authorization server and serve RFC 8414 metadata derived from the
   * issuer's OIDC discovery document. Needed for IdPs such as Cognito that publish no
   * /.well-known/oauth-authorization-server and no code_challenge_methods_supported (Kiro checks both).
   */
  authServerMetadata?: 'issuer' | 'self';
  clockToleranceSec?: number;
  /** Key resolver override (tests, pinned keys). */
  keys?: JWTVerifyGetKey;
}

export interface Principal {
  sub?: string;
  user?: string;
  clientId?: string;
  scopes: string[];
  groups: string[];
  /** Repos this principal may query: '*' = all. */
  repos: '*' | ReadonlySet<string>;
}

export type AuthOutcome =
  | { ok: true; info: AuthInfo; principal: Principal }
  | { ok: false; status: 401 | 403 | 503; headers: Record<string, string>; body: string };

const asList = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]).filter(Boolean);

function claimList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') return v.split(/[\s,]+/).filter(Boolean);
  return [];
}

/** Quoted-string safe for an auth-param value. */
const q = (s: string) => s.replace(/["\\\r\n]/g, ' ');

type Acl = Record<string, string[]>;

function parseAcl(raw: unknown, source: string): Acl {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`repos ACL ${source}: expected {"group": ["repo"|"*"]}`);
  const out: Acl = {};
  for (const [group, repos] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(repos) || repos.some((r) => typeof r !== 'string')) throw new Error(`repos ACL ${source}: "${group}" must be a list of repo names`);
    out[group] = repos as string[];
  }
  return out;
}

export class Authenticator {
  readonly resource: string;
  /** URL of our RFC 9728 document (advertised in WWW-Authenticate). */
  readonly resourceMetadataUrl: string;
  private readonly keys: JWTVerifyGetKey;
  private readonly accepted: string[];
  private readonly scopes: string[];
  private readonly telemetryScopes: string[];
  private acl?: Acl;
  private aclStamp = '';
  private aclCheckedAt = 0;
  private asMetadata?: { at: number; doc: Record<string, unknown> };

  constructor(private readonly o: AuthOptions) {
    if (!o.issuer) throw new Error('auth: issuer is required');
    if (!o.resourceUrl) throw new Error('auth: resourceUrl is required');
    const resource = new URL(o.resourceUrl);
    resource.hash = '';
    this.resource = resource.href.replace(/\/$/, '');
    // RFC 9728 §3.1: the well-known segment goes between the host and the resource path.
    const path = resource.pathname.replace(/\/$/, '');
    this.resourceMetadataUrl = `${resource.origin}/.well-known/oauth-protected-resource${path}`;
    const jwks = o.jwksUrl ?? `${o.issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
    this.keys = o.keys ?? createRemoteJWKSet(new URL(jwks), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
    this.accepted = [...asList(o.audience), ...asList(o.clientId)];
    this.scopes = o.requiredScopes ?? [];
    this.telemetryScopes = o.telemetryScopes?.length ? o.telemetryScopes : this.scopes;
    if (typeof o.reposAcl === 'object') this.acl = parseAcl(o.reposAcl, 'option');
    else if (typeof o.reposAcl === 'string') this.loadAclFile(true);
  }

  /** The authorization server URL clients are sent to. */
  get authorizationServer(): string {
    return this.o.authServerMetadata === 'self' ? new URL(this.resource).origin : this.o.issuer;
  }

  get servesAuthServerMetadata(): boolean {
    return this.o.authServerMetadata === 'self';
  }

  protectedResourceMetadata(): Record<string, unknown> {
    const doc: Record<string, unknown> = {
      resource: this.resource,
      authorization_servers: [this.authorizationServer],
      bearer_methods_supported: ['header'],
      resource_name: 'KiroOptimizer',
    };
    if (this.scopes.length) doc.scopes_supported = this.scopes;
    return doc;
  }

  /**
   * RFC 8414 metadata for 'self' mode: the issuer's OIDC discovery document with `issuer` rewritten to us
   * (Kiro requires an exact match with authorization_servers[0]) and PKCE S256 advertised.
   */
  async authorizationServerMetadata(): Promise<Record<string, unknown>> {
    if (this.asMetadata && Date.now() - this.asMetadata.at < 3600_000) return this.asMetadata.doc;
    const url = `${this.o.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`issuer discovery ${url}: HTTP ${res.status}`);
    const upstream = (await res.json()) as Record<string, unknown>;
    const doc: Record<string, unknown> = {
      ...upstream,
      issuer: this.authorizationServer,
      code_challenge_methods_supported: upstream.code_challenge_methods_supported ?? ['S256'],
      grant_types_supported: upstream.grant_types_supported ?? ['authorization_code', 'refresh_token'],
      response_types_supported: upstream.response_types_supported ?? ['code'],
      token_endpoint_auth_methods_supported: upstream.token_endpoint_auth_methods_supported ?? ['none', 'client_secret_basic', 'client_secret_post'],
    };
    if (this.scopes.length && !doc.scopes_supported) doc.scopes_supported = this.scopes;
    this.asMetadata = { at: Date.now(), doc };
    return doc;
  }

  private challenge(status: 401 | 403, scopes: string[], error?: 'invalid_token' | 'insufficient_scope', description?: string): AuthOutcome {
    const parts = [`resource_metadata="${this.resourceMetadataUrl}"`];
    if (error) parts.push(`error="${error}"`);
    if (description) parts.push(`error_description="${q(description)}"`);
    if (scopes.length) parts.push(`scope="${q(scopes.join(' '))}"`);
    return {
      ok: false,
      status,
      headers: { 'WWW-Authenticate': `Bearer ${parts.join(', ')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error ?? 'unauthorized', error_description: description ?? 'bearer token required' }),
    };
  }

  /** `route` picks the required scopes: `telemetry` uses `telemetryScopes` when they are configured. */
  async authenticate(headers: IncomingHttpHeaders, route: 'mcp' | 'telemetry' = 'mcp'): Promise<AuthOutcome> {
    const required = route === 'telemetry' ? this.telemetryScopes : this.scopes;
    const header = headers.authorization;
    const m = typeof header === 'string' ? /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)\s*$/i.exec(header) : null;
    // RFC 6750 §3.1: no error code when the request carried no credentials.
    if (!m) return header ? this.challenge(401, required, 'invalid_token', 'malformed authorization header') : this.challenge(401, required);
    const token = m[1];
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        issuer: this.o.issuer,
        clockTolerance: this.o.clockToleranceSec ?? 60,
        requiredClaims: ['exp'], // jose would otherwise accept a never-expiring token
      }));
    } catch (err) {
      // jose tags every token problem with a code; none (fetch failure) or a JWKS timeout means the IdP is
      // unreachable: a 401 would only send clients into a pointless re-login loop.
      const code = (err as { code?: string }).code;
      if (!code || code === 'ERR_JWKS_TIMEOUT') {
        return {
          ok: false,
          status: 503,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '5' },
          body: JSON.stringify({ error: 'temporarily_unavailable', error_description: 'cannot reach the token issuer keys' }),
        };
      }
      return this.challenge(401, required, 'invalid_token', (err as Error).message?.slice(0, 120) || 'invalid token');
    }
    if (payload.token_use === 'id') return this.challenge(401, required, 'invalid_token', 'id tokens are not accepted; send the access token');
    const clientId = typeof payload.client_id === 'string' ? payload.client_id : typeof payload.azp === 'string' ? payload.azp : undefined;
    if (this.accepted.length) {
      const aud = claimList(payload.aud);
      const ok = aud.some((a) => this.accepted.includes(a)) || (clientId !== undefined && this.accepted.includes(clientId));
      if (!ok) return this.challenge(401, required, 'invalid_token', 'token audience/client not accepted');
    }
    const scopes = [...new Set([...claimList(payload.scope), ...claimList(payload.scp)])];
    const missing = required.filter((s) => !scopes.includes(s));
    if (missing.length) return this.challenge(403, required, 'insufficient_scope', `missing scope ${missing.join(' ')}`);

    const groups = [...new Set([...claimList(payload['cognito:groups']), ...claimList(payload.groups)])];
    const user = [payload.username, payload['cognito:username'], payload.email, payload.preferred_username, payload.sub].find(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
    const principal: Principal = { sub: payload.sub, user, clientId, scopes, groups, repos: this.reposFor(groups) };
    const info: AuthInfo = {
      token,
      clientId: clientId ?? claimList(payload.aud)[0] ?? '',
      scopes,
      expiresAt: typeof payload.exp === 'number' ? payload.exp : undefined,
      extra: { principal },
    };
    return { ok: true, info, principal };
  }

  private loadAclFile(initial = false): void {
    const file = this.o.reposAcl as string;
    const now = Date.now();
    if (!initial && now - this.aclCheckedAt < 30_000) return;
    this.aclCheckedAt = now;
    let stamp = '';
    try {
      const s = statSync(file);
      stamp = `${s.mtimeMs}:${s.size}`;
    } catch (err) {
      if (initial) throw new Error(`repos ACL ${file}: ${(err as Error).message}`);
      return; // keep the last good ACL if the file disappears transiently
    }
    if (stamp === this.aclStamp) return;
    try {
      this.acl = parseAcl(JSON.parse(readFileSync(file, 'utf8')), file);
      this.aclStamp = stamp;
    } catch (err) {
      if (initial) throw err;
      process.stderr.write(`kopt: keeping previous repos ACL: ${(err as Error).message}\n`);
    }
  }

  /** Repos granted by the ACL to these groups; no ACL configured = every authenticated user sees all repos. */
  reposFor(groups: string[]): '*' | ReadonlySet<string> {
    if (typeof this.o.reposAcl === 'string') this.loadAclFile();
    if (!this.acl) return '*';
    const out = new Set<string>();
    for (const g of [...groups, '*']) {
      for (const r of this.acl[g] ?? []) {
        if (r === '*') return '*';
        out.add(r);
      }
    }
    return out;
  }
}

/** Principal attached by Authenticator to the SDK AuthInfo. */
export function principalOf(info?: AuthInfo): Principal | undefined {
  return info?.extra?.principal as Principal | undefined;
}

export function repoAllowed(principal: Principal | undefined, repo: string): boolean {
  if (!principal) return true; // auth disabled
  return principal.repos === '*' || principal.repos.has(repo);
}
