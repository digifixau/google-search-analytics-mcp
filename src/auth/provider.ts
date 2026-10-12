import type { Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { MCP_SCOPES, type Config } from '../config.js';
import { randomToken, safeEqual, sha256 } from '../store/crypto.js';
import { KvStore, type Db } from '../store/db.js';
import { LoginGuard } from './guard.js';
import { connectorForResource, connectorUrl, enabledConnectors } from '../mcp/connectors.js';
import { consentPage, page } from './pages.js';

const CODE_TTL_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
/** After approve/deny, a resubmitted form (double click, refresh) is sent to the same place for this long. */
const COMPLETED_REPLAY_MS = 5 * 60 * 1000;
/** Registered clients that never obtain a token are forgotten after this long. */
const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;

interface PendingAuthorization {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAt: number;
  completedLocation?: string;
}

interface StoredCode {
  clientId: string;
  scopes: string[];
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
}

export type ConsentOutcome =
  | { kind: 'redirect'; location: string; approved: boolean }
  | { kind: 'page'; status: number; html: string };

function isLoopback(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}

class SqliteClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly db: Db) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db
      .prepare('SELECT data FROM oauth_clients WHERE client_id = ?')
      .get(clientId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as OAuthClientInformationFull) : undefined;
  }

  registerClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
    for (const uri of client.redirect_uris) {
      const u = new URL(String(uri));
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))) {
        throw new InvalidClientMetadataError('redirect_uris must use https (or http on localhost)');
      }
    }
    this.db
      .prepare('INSERT INTO oauth_clients (client_id, data, created_at) VALUES (?, ?, ?)')
      .run(client.client_id, JSON.stringify(client), Date.now());
    return client;
  }
}

/**
 * Single-tenant OAuth 2.1 authorization server: dynamic client registration, PKCE authorization code flow
 * approved by the owner with ADMIN_PASSWORD, rotating refresh tokens, and scopes mcp:read / mcp:write.
 */
export class OwnerOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: SqliteClientsStore;
  private readonly guard: LoginGuard;

  constructor(
    private readonly config: Config,
    private readonly db: Db,
  ) {
    this.clientsStore = new SqliteClientsStore(db);
    this.guard = new LoginGuard(new KvStore(db));
  }

  private writeAvailable(): boolean {
    return this.config.accessMode === 'readwrite';
  }

  /**
   * Tokens are bound to the MCP endpoint (RFC 8707 resource) they were approved for.
   * Without a resource parameter the token is valid on every endpoint (older clients, CLI tools).
   */
  private validateResource(resource: URL | string | undefined): string | undefined {
    if (!resource) return undefined;
    const connector = connectorForResource(resource, this.config);
    if (!connector) {
      const known = enabledConnectors(this.config)
        .map((c) => connectorUrl(c, this.config.publicUrl!).href)
        .join(', ');
      throw new InvalidTargetError(`Unknown resource ${String(resource)}. Use one of: ${known}`);
    }
    return connectorUrl(connector, this.config.publicUrl!).href;
  }

  /** Name of the MCP a resource refers to, for the consent page and /setup. */
  private resourceTitle(resource: URL | string | null | undefined): string {
    if (!resource) {
      const all = enabledConnectors(this.config);
      return all.length === 1 ? all[0]!.title : 'every MCP on this server';
    }
    return connectorForResource(resource, this.config)?.title ?? String(resource);
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    this.validateResource(params.resource);
    const unknown = (params.scopes ?? []).filter(
      (s) => s !== MCP_SCOPES.read && s !== MCP_SCOPES.write && s !== 'offline_access',
    );
    if (unknown.length) throw new InvalidScopeError(`Unsupported scope(s): ${unknown.join(' ')}`);

    this.sweep();
    const requestId = randomToken(24);
    this.db
      .prepare(
        'INSERT INTO pending_authorizations (id_hash, client_id, params, expires_at) VALUES (?, ?, ?, ?)',
      )
      .run(
        sha256(requestId),
        client.client_id,
        JSON.stringify({ ...params, resource: params.resource?.href }),
        Date.now() + PENDING_TTL_MS,
      );
    res
      .status(200)
      .set({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      })
      .send(this.renderConsent(requestId));
  }

  private loadPending(requestId: string | undefined): PendingAuthorization | undefined {
    if (!requestId) return undefined;
    const row = this.db
      .prepare(
        'SELECT client_id, params, expires_at, completed_location FROM pending_authorizations WHERE id_hash = ?',
      )
      .get(sha256(requestId)) as
      | { client_id: string; params: string; expires_at: number; completed_location: string | null }
      | undefined;
    if (!row || row.expires_at < Date.now()) return undefined;
    const client = this.clientsStore.getClient(row.client_id);
    if (!client) return undefined;
    const stored = JSON.parse(row.params) as AuthorizationParams & { resource?: string };
    return {
      client,
      params: { ...stored, resource: stored.resource ? new URL(stored.resource) : undefined },
      expiresAt: row.expires_at,
      completedLocation: row.completed_location ?? undefined,
    };
  }

  /** Marks a request as finished; resubmits within COMPLETED_REPLAY_MS go to the same location. */
  private completePending(requestId: string, location: string): void {
    this.db
      .prepare(
        'UPDATE pending_authorizations SET completed_location = ?, expires_at = ? WHERE id_hash = ?',
      )
      .run(location, Date.now() + COMPLETED_REPLAY_MS, sha256(requestId));
  }

  private renderConsent(requestId: string, error?: string): string {
    const p = this.loadPending(requestId)!;
    return consentPage({
      requestId,
      clientName: p.client.client_name ?? 'An MCP client',
      mcpTitle: this.resourceTitle(p.params.resource),
      redirectHost: new URL(p.params.redirectUri).host,
      writeAvailable: this.writeAvailable(),
      writeRequested: (p.params.scopes ?? []).includes(MCP_SCOPES.write),
      accessMode: this.config.accessMode,
      error,
    });
  }

  /** Brute-force guard for password prompts (per IP and server-wide). */
  checkRateLimit(ip: string): boolean {
    return this.guard.allowed(ip);
  }

  recordFailure(ip: string): void {
    this.guard.recordFailure(ip);
  }

  verifyPassword(password: string | undefined): boolean {
    return Boolean(password) && safeEqual(password!, this.config.adminPassword ?? randomToken());
  }

  /** Handles the consent form post. */
  handleConsent(
    form: { request_id?: string; password?: string; decision?: string; scope_write?: string },
    ip: string,
  ): ConsentOutcome {
    const pending = this.loadPending(form.request_id);
    if (!pending) {
      return {
        kind: 'page',
        status: 400,
        html: consentExpired(),
      };
    }
    if (pending.completedLocation) {
      return {
        kind: 'redirect',
        location: pending.completedLocation,
        approved: new URL(pending.completedLocation).searchParams.has('code'),
      };
    }
    const { client, params } = pending;
    const redirect = new URL(params.redirectUri);
    if (params.state !== undefined) redirect.searchParams.set('state', params.state);

    if (form.decision !== 'approve') {
      redirect.searchParams.set('error', 'access_denied');
      redirect.searchParams.set('error_description', 'The owner denied the request');
      this.completePending(form.request_id!, redirect.href);
      return { kind: 'redirect', location: redirect.href, approved: false };
    }
    if (!this.checkRateLimit(ip)) {
      return {
        kind: 'page',
        status: 429,
        html: this.renderConsent(form.request_id!, 'Too many attempts. Try again in 15 minutes.'),
      };
    }
    if (!this.verifyPassword(form.password)) {
      this.recordFailure(ip);
      return {
        kind: 'page',
        status: 401,
        html: this.renderConsent(form.request_id!, 'Incorrect password.'),
      };
    }

    const scopes: string[] = [MCP_SCOPES.read];
    if (this.writeAvailable() && form.scope_write === '1') scopes.push(MCP_SCOPES.write);

    const code = randomToken(32);
    const stored: StoredCode = {
      clientId: client.client_id,
      scopes,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      resource: this.validateResource(params.resource),
    };
    this.db
      .prepare(
        'INSERT INTO auth_codes (code_hash, client_id, data, expires_at) VALUES (?, ?, ?, ?)',
      )
      .run(sha256(code), client.client_id, JSON.stringify(stored), Date.now() + CODE_TTL_MS);
    redirect.searchParams.set('code', code);
    this.completePending(form.request_id!, redirect.href);
    return { kind: 'redirect', location: redirect.href, approved: true };
  }

  private loadCode(client: OAuthClientInformationFull, code: string): StoredCode {
    const row = this.db
      .prepare('SELECT data, expires_at, client_id FROM auth_codes WHERE code_hash = ?')
      .get(sha256(code)) as { data: string; expires_at: number; client_id: string } | undefined;
    if (!row || row.expires_at < Date.now() || row.client_id !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return JSON.parse(row.data) as StoredCode;
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    return this.loadCode(client, authorizationCode).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const stored = this.loadCode(client, authorizationCode);
    this.db.prepare('DELETE FROM auth_codes WHERE code_hash = ?').run(sha256(authorizationCode));
    if (redirectUri && redirectUri !== stored.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    return this.issueTokens(client.client_id, stored.scopes, stored.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const hash = sha256(refreshToken);
    const row = this.db
      .prepare(
        "SELECT client_id, scopes, resource, expires_at FROM tokens WHERE token_hash = ? AND kind = 'refresh'",
      )
      .get(hash) as
      | { client_id: string; scopes: string; resource: string | null; expires_at: number }
      | undefined;
    if (!row || row.expires_at < Date.now() || row.client_id !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    const granted = row.scopes.split(' ');
    const requested = scopes?.length ? scopes : granted;
    if (requested.some((s) => !granted.includes(s))) {
      throw new InvalidScopeError('Requested scopes exceed the original grant');
    }
    // Rotate: the old refresh token is single-use.
    this.db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(hash);
    return this.issueTokens(client.client_id, requested, row.resource ?? undefined);
  }

  private issueTokens(
    clientId: string,
    scopes: string[],
    resource: string | undefined,
  ): OAuthTokens {
    this.sweep();
    const now = Date.now();
    const accessToken = `gsa_at_${randomToken(32)}`;
    const refreshToken = `gsa_rt_${randomToken(32)}`;
    const insert = this.db.prepare(
      'INSERT INTO tokens (token_hash, kind, client_id, scopes, resource, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run(
      sha256(accessToken),
      'access',
      clientId,
      scopes.join(' '),
      resource ?? null,
      now + this.config.accessTokenTtlSeconds * 1000,
      now,
    );
    insert.run(
      sha256(refreshToken),
      'refresh',
      clientId,
      scopes.join(' '),
      resource ?? null,
      now + this.config.refreshTokenTtlSeconds * 1000,
      now,
    );
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    for (const key of this.config.apiKeys) {
      if (safeEqual(token, key.key)) {
        return {
          token,
          clientId: `api-key:${key.label}`,
          scopes: key.scopes,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        };
      }
    }
    const row = this.db
      .prepare(
        "SELECT client_id, scopes, resource, expires_at FROM tokens WHERE token_hash = ? AND kind = 'access'",
      )
      .get(sha256(token)) as
      | { client_id: string; scopes: string; resource: string | null; expires_at: number }
      | undefined;
    if (!row || row.expires_at < Date.now())
      throw new InvalidTokenError('Invalid or expired access token');
    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes.split(' ').filter(Boolean),
      expiresAt: Math.floor(row.expires_at / 1000),
      resource: row.resource ? new URL(row.resource) : undefined,
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    this.db
      .prepare('DELETE FROM tokens WHERE token_hash = ? AND client_id = ?')
      .run(sha256(request.token), client.client_id);
  }

  /** Revokes every token of a client and forgets the client (used by the setup dashboard). */
  revokeClient(clientId: string): void {
    this.db.prepare('DELETE FROM tokens WHERE client_id = ?').run(clientId);
    this.db.prepare('DELETE FROM auth_codes WHERE client_id = ?').run(clientId);
    this.db.prepare('DELETE FROM oauth_clients WHERE client_id = ?').run(clientId);
  }

  listClients(): Array<{
    clientId: string;
    name: string;
    mcp: string;
    scopes: string;
    lastIssued: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT c.client_id, c.data, MAX(t.created_at) AS last, GROUP_CONCAT(DISTINCT t.scopes) AS scopes,
                GROUP_CONCAT(DISTINCT COALESCE(t.resource, '')) AS resources
         FROM oauth_clients c JOIN tokens t ON t.client_id = c.client_id AND t.kind = 'refresh' AND t.expires_at > ?
         GROUP BY c.client_id ORDER BY last DESC`,
      )
      .all(Date.now()) as Array<{
      client_id: string;
      data: string;
      last: number;
      scopes: string;
      resources: string;
    }>;
    return rows.map((r) => ({
      clientId: r.client_id,
      name: (JSON.parse(r.data) as OAuthClientInformationFull).client_name ?? 'Unnamed client',
      mcp: [...new Set(r.resources.split(','))].map((res) => this.resourceTitle(res)).join(', '),
      scopes: [...new Set(r.scopes.split(/[ ,]/))].join(' '),
      lastIssued: new Date(r.last).toISOString(),
    }));
  }

  private sweep(): void {
    const now = Date.now();
    this.db.prepare('DELETE FROM auth_codes WHERE expires_at < ?').run(now);
    this.db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(now);
    // Open dynamic registration means anyone can register a client; drop ones that never got approved.
    this.db
      .prepare(
        'DELETE FROM oauth_clients WHERE created_at < ? AND client_id NOT IN (SELECT DISTINCT client_id FROM tokens)',
      )
      .run(now - UNUSED_CLIENT_TTL_MS);
    this.db.prepare('DELETE FROM pending_authorizations WHERE expires_at < ?').run(now);
  }
}

function consentExpired(): string {
  return page(
    'Request expired',
    '<div class="card"><h1>Request expired</h1><p>This approval link is older than 10 minutes or was already used. Close this tab and start the connection again from ChatGPT, Claude or your MCP client.</p></div>',
  );
}
