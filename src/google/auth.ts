import { existsSync, readFileSync } from 'node:fs';
import { GoogleAuth, OAuth2Client, type AuthClient } from 'google-auth-library';
import type { Config } from '../config.js';
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
const KV_KEY = 'google.oauth';

/** The Google OAuth scopes this server needs for its configured access mode and toolsets. */
export function requiredGoogleScopes(config: Config): string[] {
  const services = new Set(config.enabledServices);
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
}

export interface GoogleAuthStatus {
  mode: 'oauth' | 'service_account';
  connected: boolean;
  identity?: string;
  grantedScopes: string[];
  missingScopes: string[];
  connectedAt?: string;
}

export class GoogleNotConnectedError extends Error {}

export class GoogleAuthManager {
  private client: AuthClient | undefined;

  constructor(
    private readonly config: Config,
    private readonly kv: KvStore,
    private readonly encryptor: Encryptor | undefined,
  ) {}

  get mode(): 'oauth' | 'service_account' {
    return this.config.google.authMode;
  }

  status(): GoogleAuthStatus {
    const required = requiredGoogleScopes(this.config);
    if (this.mode === 'service_account') {
      const key = loadServiceAccountKey(this.config.google.serviceAccountJson!);
      return {
        mode: 'service_account',
        connected: true,
        identity: key.client_email,
        grantedScopes: required,
        missingScopes: [],
      };
    }
    const stored = this.readStored();
    return {
      mode: 'oauth',
      connected: Boolean(stored),
      identity: stored?.email,
      grantedScopes: stored?.scopes ?? [],
      missingScopes: stored ? missingScopes(required, stored.scopes) : required,
      connectedAt: stored?.connectedAt,
    };
  }

  /** Returns an authenticated client or throws an actionable error. */
  async getClient(): Promise<AuthClient> {
    if (this.client) return this.client;

    if (this.mode === 'service_account') {
      const credentials = loadServiceAccountKey(this.config.google.serviceAccountJson!);
      const auth = new GoogleAuth({ credentials, scopes: requiredGoogleScopes(this.config) });
      this.client = await auth.getClient();
      return this.client;
    }

    const stored = this.readStored();
    if (!stored) {
      throw new GoogleNotConnectedError(
        'Google account is not connected yet. The server owner must open ' +
          `${this.setupHint()} and click "Connect Google".`,
      );
    }
    const oauth = this.newOAuthClient();
    oauth.setCredentials({ refresh_token: stored.refreshToken });
    oauth.on('tokens', (tokens) => {
      if (tokens.refresh_token && tokens.refresh_token !== stored.refreshToken) {
        this.writeStored({ ...stored, refreshToken: tokens.refresh_token });
      }
    });
    this.client = oauth;
    return oauth;
  }

  /** Google consent URL for the owner (oauth mode only). */
  buildConsentUrl(redirectUri: string, state: string): string {
    const scopes = [...IDENTITY_SCOPES, ...requiredGoogleScopes(this.config)];
    return this.newOAuthClient(redirectUri).generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: scopes,
      state,
      login_hint: this.config.google.ownerEmail,
    });
  }

  /** Exchanges the consent code, enforces GOOGLE_OWNER_EMAIL and stores the refresh token. */
  async completeConsent(code: string, redirectUri: string): Promise<GoogleAuthStatus> {
    const oauth = this.newOAuthClient(redirectUri);
    const { tokens } = await oauth.getToken(code);
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
    const owner = this.config.google.ownerEmail;
    if (owner && email !== owner) {
      throw new Error(
        `Signed in as ${email ?? 'an unknown account'}, but GOOGLE_OWNER_EMAIL is ${owner}. Connection refused.`,
      );
    }
    const scopes = (tokens.scope ?? '').split(/\s+/).filter(Boolean);
    this.writeStored({
      refreshToken: tokens.refresh_token,
      scopes,
      email,
      connectedAt: new Date().toISOString(),
    });
    this.client = undefined;
    return this.status();
  }

  disconnect(): void {
    this.kv.delete(KV_KEY);
    this.client = undefined;
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
      : '`npx google-search-analytics-mcp google-auth`';
  }

  private readStored(): StoredOAuthCredentials | undefined {
    const raw = this.kv.get(KV_KEY);
    if (!raw || !this.encryptor) return undefined;
    try {
      return JSON.parse(this.encryptor.decrypt(raw)) as StoredOAuthCredentials;
    } catch {
      throw new Error(
        'Stored Google credentials could not be decrypted. Was ENCRYPTION_KEY changed? Reconnect Google via /setup.',
      );
    }
  }

  private writeStored(value: StoredOAuthCredentials): void {
    if (!this.encryptor) throw new Error('ENCRYPTION_KEY is required to store Google credentials');
    this.kv.set(KV_KEY, this.encryptor.encrypt(JSON.stringify(value)));
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
