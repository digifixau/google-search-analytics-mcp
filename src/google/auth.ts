import { existsSync, readFileSync } from 'node:fs';
import {
  CodeChallengeMethod,
  GoogleAuth,
  OAuth2Client,
  type AuthClient,
} from 'google-auth-library';
import { allowedEmailsFor, serviceAccountFor, type Config, type Service } from '../config.js';
import { enabledConnectors, type ConnectorDef } from '../mcp/connectors.js';
import type { Encryptor } from '../store/crypto.js';
import type { KvStore } from '../store/db.js';

export const GOOGLE_SCOPES = {
  gscRead: 'https://www.googleapis.com/auth/webmasters.readonly',
  gscWrite: 'https://www.googleapis.com/auth/webmasters',
  gaRead: 'https://www.googleapis.com/auth/analytics.readonly',
  gaEdit: 'https://www.googleapis.com/auth/analytics.edit',
  indexing: 'https://www.googleapis.com/auth/indexing',
  gtmRead: 'https://www.googleapis.com/auth/tagmanager.readonly',
  gtmEdit: 'https://www.googleapis.com/auth/tagmanager.edit.containers',
  gtmVersions: 'https://www.googleapis.com/auth/tagmanager.edit.containerversions',
  gtmPublish: 'https://www.googleapis.com/auth/tagmanager.publish',
  ytAnalytics: 'https://www.googleapis.com/auth/yt-analytics.readonly',
  ytMonetary: 'https://www.googleapis.com/auth/yt-analytics-monetary.readonly',
  ytRead: 'https://www.googleapis.com/auth/youtube.readonly',
  ytManage: 'https://www.googleapis.com/auth/youtube',
  /** The Merchant API has a single read+write scope. */
  merchant: 'https://www.googleapis.com/auth/content',
} as const;

const IDENTITY_SCOPES = ['openid', 'email'];
/** KV key of the single connection used before per-MCP connections existed. Never modified. */
export const LEGACY_KV_KEY = 'google.oauth';
const kvKey = (connectionId: string) => `google.oauth.${connectionId}`;
const disconnectedKey = (connectionId: string) => `google.oauth.${connectionId}.disconnected`;

/** The Google OAuth scopes needed for the given services (default: all enabled services). */
export function requiredGoogleScopes(
  config: Config,
  forServices: readonly Service[] = config.enabledServices,
): string[] {
  const services = new Set(forServices.filter((s) => config.enabledServices.includes(s)));
  const write = config.accessMode === 'readwrite';
  const toolsets = new Set(write ? config.writeToolsets : []);
  const scopes: string[] = [];
  if (services.has('gsc')) {
    scopes.push(toolsets.has('gsc') ? GOOGLE_SCOPES.gscWrite : GOOGLE_SCOPES.gscRead);
    if (toolsets.has('indexing')) scopes.push(GOOGLE_SCOPES.indexing);
  }
  if (services.has('ga4')) {
    scopes.push(GOOGLE_SCOPES.gaRead);
    if (toolsets.has('ga4_admin') || toolsets.has('ga4_audiences_streams')) {
      scopes.push(GOOGLE_SCOPES.gaEdit);
    }
  }
  if (services.has('gtm')) {
    // tagmanager.readonly is not implied by the edit scopes, so it is always requested.
    scopes.push(GOOGLE_SCOPES.gtmRead);
    if (toolsets.has('gtm')) scopes.push(GOOGLE_SCOPES.gtmEdit, GOOGLE_SCOPES.gtmVersions);
    if (toolsets.has('gtm_publish')) scopes.push(GOOGLE_SCOPES.gtmPublish);
  }
  if (services.has('youtube')) {
    scopes.push(
      GOOGLE_SCOPES.ytAnalytics,
      GOOGLE_SCOPES.ytMonetary,
      toolsets.has('youtube') ? GOOGLE_SCOPES.ytManage : GOOGLE_SCOPES.ytRead,
    );
  }
  if (services.has('merchant')) scopes.push(GOOGLE_SCOPES.merchant);
  return scopes;
}

/** Scopes for one MCP's own Google connection. */
export function connectionScopes(config: Config, connector: ConnectorDef): string[] {
  const scopes = requiredGoogleScopes(config, connector.services);
  // gtm_audit_container cross-checks GA4 measurement IDs using the GTM account's own credentials.
  if (connector.services.includes('gtm') && !scopes.includes(GOOGLE_SCOPES.gaRead)) {
    scopes.push(GOOGLE_SCOPES.gaRead);
  }
  return scopes;
}

/** `webmasters` implies `webmasters.readonly`; everything else must be granted literally. */
export function missingScopes(required: string[], granted: string[]): string[] {
  const have = new Set(granted);
  if (have.has(GOOGLE_SCOPES.gscWrite)) have.add(GOOGLE_SCOPES.gscRead);
  if (have.has(GOOGLE_SCOPES.ytManage)) have.add(GOOGLE_SCOPES.ytRead);
  return required.filter((scope) => !have.has(scope));
}

interface StoredOAuthCredentials {
  refreshToken: string;
  scopes: string[];
  email?: string;
  connectedAt: string;
  /** Copied from the shared pre-upgrade connection rather than connected on its own. */
  migratedFromShared?: boolean;
}

export interface GoogleAuthStatus {
  connectionId: string;
  title: string;
  mode: 'oauth' | 'service_account' | 'api_key';
  connected: boolean;
  identity?: string;
  grantedScopes: string[];
  missingScopes: string[];
  connectedAt?: string;
  migratedFromShared?: boolean;
  allowedEmails: string[];
}

export class GoogleNotConnectedError extends Error {}

/**
 * One MCP's Google connection: its own account, encrypted refresh token, scopes and API client.
 * Nothing here reads or writes another connection's credentials.
 */
export class GoogleConnection {
  private client: AuthClient | undefined;

  constructor(
    private readonly config: Config,
    readonly connector: ConnectorDef,
    private readonly kv: KvStore,
    private readonly encryptor: Encryptor | undefined,
  ) {}

  get id(): string {
    return this.connector.id;
  }

  get title(): string {
    return this.connector.title;
  }

  get mode(): 'oauth' | 'service_account' | 'api_key' {
    return this.connector.authKind === 'api_key' ? 'api_key' : this.config.google.authMode;
  }

  get scopes(): string[] {
    return connectionScopes(this.config, this.connector);
  }

  get allowedEmails(): string[] {
    return allowedEmailsFor(this.config, this.id);
  }

  status(): GoogleAuthStatus {
    const base = {
      connectionId: this.id,
      title: this.title,
      allowedEmails: this.allowedEmails,
    };
    if (this.mode === 'api_key') {
      // The key itself is never part of the status: only whether it is set.
      return {
        ...base,
        mode: 'api_key',
        connected: Boolean(this.config.google.placesApiKey),
        identity: 'API key',
        grantedScopes: [],
        missingScopes: [],
      };
    }
    if (this.mode === 'service_account') {
      const key = loadServiceAccountKey(serviceAccountFor(this.config, this.id)!);
      return {
        ...base,
        mode: 'service_account',
        connected: true,
        identity: key.client_email,
        grantedScopes: this.scopes,
        missingScopes: [],
      };
    }
    const stored = this.readStored();
    return {
      ...base,
      mode: 'oauth',
      connected: Boolean(stored),
      identity: stored?.email,
      grantedScopes: stored?.scopes ?? [],
      missingScopes: stored ? missingScopes(this.scopes, stored.scopes) : this.scopes,
      connectedAt: stored?.connectedAt,
      migratedFromShared: stored?.migratedFromShared,
    };
  }

  /** Returns this connection's authenticated client or throws an actionable error. */
  async getClient(): Promise<AuthClient> {
    this.assertGoogleAccount();
    if (this.client) return this.client;

    if (this.mode === 'service_account') {
      const credentials = loadServiceAccountKey(serviceAccountFor(this.config, this.id)!);
      const auth = new GoogleAuth({ credentials, scopes: this.scopes });
      this.client = await auth.getClient();
      return this.client;
    }

    const stored = this.readStored();
    if (!stored) {
      throw new GoogleNotConnectedError(
        `The ${this.title} MCP has no Google account connected yet. The server owner must open ` +
          `${this.setupHint()} and click "Connect" on the ${this.title} card.`,
      );
    }
    const oauth = this.newOAuthClient();
    oauth.setCredentials({ refresh_token: stored.refreshToken });
    oauth.on('tokens', (tokens) => {
      // Google rarely rotates refresh tokens; when it does, persist it for this connection only.
      const current = this.readStored();
      if (tokens.refresh_token && current && tokens.refresh_token !== current.refreshToken) {
        this.writeStored({ ...current, refreshToken: tokens.refresh_token });
      }
    });
    this.client = oauth;
    return oauth;
  }

  /** Google consent URL for this connection (oauth mode only). */
  buildConsentUrl(redirectUri: string, state: string, codeChallenge: string): string {
    this.assertGoogleAccount();
    return this.newOAuthClient(redirectUri).generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      // Never merge scopes granted to other connections on the same Google account.
      include_granted_scopes: false,
      scope: [...IDENTITY_SCOPES, ...this.scopes],
      state,
      // Only hint when there is exactly one choice (an empty login_hint would still be sent).
      ...(this.allowedEmails.length === 1 ? { login_hint: this.allowedEmails[0] } : {}),
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });
  }

  /** Exchanges the consent code (PKCE), enforces the allowed accounts and stores this connection's token. */
  async completeConsent(
    code: string,
    redirectUri: string,
    codeVerifier: string,
  ): Promise<GoogleAuthStatus> {
    this.assertGoogleAccount();
    const oauth = this.newOAuthClient(redirectUri);
    const { tokens } = await oauth.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.refresh_token) {
      throw new Error(
        'Google did not return a refresh token. Remove this app from https://myaccount.google.com/permissions and try again.',
      );
    }
    let email: string | undefined;
    if (tokens.id_token) {
      const ticket = await oauth.verifyIdToken({
        idToken: tokens.id_token,
        audience: this.config.google.clientId!,
      });
      const payload = ticket.getPayload();
      // Only trust an email Google has verified.
      if (payload?.email_verified) email = payload.email?.toLowerCase();
    }
    const allowed = this.allowedEmails;
    if (allowed.length > 0 && (!email || !allowed.includes(email))) {
      throw new Error(
        `Signed in as ${email ?? 'an unknown account'}, which is not allowed for the ${this.title} MCP (allowed: ${allowed.join(', ')}). Connection refused.`,
      );
    }
    const scopes = (tokens.scope ?? '').split(/\s+/).filter(Boolean);
    this.writeStored({
      refreshToken: tokens.refresh_token,
      scopes,
      email,
      connectedAt: new Date().toISOString(),
    });
    this.kv.delete(disconnectedKey(this.id));
    this.client = undefined;
    return this.status();
  }

  /**
   * Forgets this connection's token. Deliberately does not call Google's revoke endpoint: revoking
   * ends the whole grant, which would also break other MCPs connected with the same Google account.
   */
  disconnect(): void {
    if (this.mode === 'api_key') return;
    this.kv.delete(kvKey(this.id));
    this.kv.set(disconnectedKey(this.id), new Date().toISOString());
    this.client = undefined;
  }

  /**
   * Copies the pre-upgrade shared connection into this one, unless it has its own, was disconnected,
   * or is restricted (GOOGLE_OWNER_EMAIL_<MCP>) to accounts that don't include the shared one.
   */
  adoptShared(legacyCiphertext: string): 'adopted' | 'skipped' | 'not-allowed' {
    if (this.mode === 'api_key') return 'skipped';
    if (this.kv.get(kvKey(this.id)) || this.kv.get(disconnectedKey(this.id))) return 'skipped';
    const legacy = this.decrypt(legacyCiphertext);
    const allowed = this.allowedEmails;
    if (allowed.length > 0 && (!legacy.email || !allowed.includes(legacy.email))) {
      return 'not-allowed';
    }
    this.writeStored({ ...legacy, migratedFromShared: true });
    return 'adopted';
  }

  /** API-key MCPs (Places) have no Google account, so there is nothing to sign in to. */
  private assertGoogleAccount(): void {
    if (this.mode === 'api_key') {
      throw new Error(`The ${this.title} MCP uses an API key, not a Google account.`);
    }
  }

  private newOAuthClient(redirectUri?: string): OAuth2Client {
    return new OAuth2Client({
      clientId: this.config.google.clientId,
      clientSecret: this.config.google.clientSecret,
      redirectUri,
    });
  }

  private setupHint(): string {
    return this.config.publicUrl
      ? new URL('/setup', this.config.publicUrl).toString()
      : `\`google-auth --connector ${this.id}\``;
  }

  private decrypt(raw: string): StoredOAuthCredentials {
    if (!this.encryptor) throw new Error('ENCRYPTION_KEY is required to read Google credentials');
    try {
      return JSON.parse(this.encryptor.decrypt(raw)) as StoredOAuthCredentials;
    } catch {
      throw new Error(
        `Stored Google credentials for the ${this.title} MCP could not be decrypted. Was ENCRYPTION_KEY changed? Reconnect it via /setup.`,
      );
    }
  }

  private readStored(): StoredOAuthCredentials | undefined {
    const raw = this.kv.get(kvKey(this.id));
    return raw ? this.decrypt(raw) : undefined;
  }

  private writeStored(value: StoredOAuthCredentials): void {
    if (!this.encryptor) throw new Error('ENCRYPTION_KEY is required to store Google credentials');
    this.kv.set(kvKey(this.id), this.encryptor.encrypt(JSON.stringify(value)));
  }
}

/** The Google connections of all enabled MCPs, one per connector. */
export class GoogleConnections {
  private readonly connections = new Map<string, GoogleConnection>();

  constructor(
    private readonly config: Config,
    private readonly kv: KvStore,
    encryptor: Encryptor | undefined,
  ) {
    for (const connector of enabledConnectors(config)) {
      this.connections.set(connector.id, new GoogleConnection(config, connector, kv, encryptor));
    }
  }

  get mode(): 'oauth' | 'service_account' {
    return this.config.google.authMode;
  }

  all(): GoogleConnection[] {
    return [...this.connections.values()];
  }

  has(connectionId: string): boolean {
    return this.connections.has(connectionId);
  }

  get(connectionId: string): GoogleConnection {
    const connection = this.connections.get(connectionId);
    if (!connection) throw new Error(`Unknown or disabled MCP connection "${connectionId}"`);
    return connection;
  }

  /**
   * One-way, non-destructive upgrade from the single shared connection: each MCP without its own
   * connection starts with a copy of it. The shared record itself is never changed or revoked, so the
   * previous version keeps working after a rollback.
   */
  migrateShared(): string[] {
    if (this.mode !== 'oauth') return [];
    const legacy = this.kv.get(LEGACY_KV_KEY);
    if (!legacy) return [];
    const migrated: string[] = [];
    const notAllowed: string[] = [];
    for (const c of this.all()) {
      const result = c.adoptShared(legacy);
      if (result === 'adopted') migrated.push(c.id);
      if (result === 'not-allowed') notAllowed.push(c.id);
    }
    if (migrated.length) {
      console.error(`[google] migrated the shared Google connection to: ${migrated.join(', ')}`);
    }
    if (notAllowed.length) {
      console.error(
        `[google] not migrated (its account is not in GOOGLE_OWNER_EMAIL_<MCP>), connect on /setup: ${notAllowed.join(', ')}`,
      );
    }
    return migrated;
  }
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  [key: string]: unknown;
}

/** Accepts raw JSON, a file path, or base64-encoded JSON. */
export function loadServiceAccountKey(value: string): ServiceAccountKey {
  let text = value.trim();
  if (!text.startsWith('{')) {
    if (existsSync(text)) {
      text = readFileSync(text, 'utf8');
    } else {
      text = Buffer.from(text, 'base64').toString('utf8');
    }
  }
  let parsed: ServiceAccountKey;
  try {
    parsed = JSON.parse(text) as ServiceAccountKey;
  } catch {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_JSON must be the key JSON, a path to the key file, or base64-encoded JSON',
    );
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('Service account key is missing client_email or private_key');
  }
  return parsed;
}
