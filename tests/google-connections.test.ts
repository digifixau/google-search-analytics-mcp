import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import type { Config } from '../src/config.js';
import {
  GOOGLE_SCOPES,
  GoogleConnections,
  GoogleNotConnectedError,
  LEGACY_KV_KEY,
} from '../src/google/auth.js';
import type { GoogleApis } from '../src/google/clients.js';
import { getConnector } from '../src/mcp/connectors.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { Encryptor } from '../src/store/crypto.js';
import { AuditLog, KvStore, openDb } from '../src/store/db.js';
import { AccessPolicy } from '../src/util/policy.js';
import { testConfig } from './helpers.js';

const KEY = 'x'.repeat(32);
const REDIRECT = 'https://mcp.example.com/oauth/google/callback';

function setup(env: Record<string, string> = {}, kv = new KvStore(openDb(':memory:'))) {
  const config = testConfig({
    GOOGLE_OWNER_EMAIL: 'owner@example.com, second@example.com',
    GOOGLE_OWNER_EMAIL_GTM: 'gtm@example.com',
    ...env,
  });
  return { config, kv, google: new GoogleConnections(config, kv, new Encryptor(KEY)) };
}

/** Mocks Google's token endpoint: each code maps to the account and refresh token it yields. */
function mockGoogle(
  accounts: Record<string, { email: string; refreshToken: string; scope?: string }>,
) {
  const getToken = vi.spyOn(OAuth2Client.prototype, 'getToken').mockImplementation((async (opts: {
    code: string;
  }) => {
    const a = accounts[opts.code];
    if (!a) throw new Error('invalid_grant');
    return {
      tokens: { refresh_token: a.refreshToken, id_token: `id-${opts.code}`, scope: a.scope ?? '' },
    };
  }) as never);
  vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockImplementation((async (opts: {
    idToken: string;
  }) => {
    const a = accounts[opts.idToken.slice(3)]!;
    return { getPayload: () => ({ email: a.email, email_verified: true }) };
  }) as never);
  return getToken;
}

const stored = (kv: KvStore, id: string) =>
  JSON.parse(new Encryptor(KEY).decrypt(kv.get(`google.oauth.${id}`)!)) as {
    refreshToken: string;
    email: string;
    migratedFromShared?: boolean;
  };

afterEach(() => vi.restoreAllMocks());

describe('per-MCP Google connections', () => {
  it('creates one connection per enabled MCP', () => {
    const { google } = setup();
    expect(google.all().map((c) => c.id)).toEqual([
      'search-analytics',
      'gtm',
      'youtube',
      'merchant',
    ]);
    const { google: some } = setup({ ENABLED_SERVICES: 'gsc,ga4,youtube' });
    expect(some.all().map((c) => c.id)).toEqual(['search-analytics', 'youtube']);
  });

  it('asks Google only for the scopes of that MCP, without merging earlier grants, using PKCE', () => {
    const { google } = setup();
    const url = new URL(google.get('gtm').buildConsentUrl(REDIRECT, 'state-1', 'challenge-1'));
    const scopes = url.searchParams.get('scope')!.split(' ');
    expect(scopes).toEqual(['openid', 'email', GOOGLE_SCOPES.gtmRead, GOOGLE_SCOPES.gaRead]);
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('login_hint')).toBe('gtm@example.com');

    // Two accounts are allowed for YouTube, so there is no hint at all.
    const ytUrl = new URL(google.get('youtube').buildConsentUrl(REDIRECT, 's', 'c'));
    expect(ytUrl.searchParams.has('login_hint')).toBe(false);
    const yt = ytUrl.searchParams.get('scope')!.split(' ');
    expect(yt).not.toContain(GOOGLE_SCOPES.gtmRead);
    expect(yt).not.toContain(GOOGLE_SCOPES.gscRead);
    expect(yt).toContain(GOOGLE_SCOPES.ytAnalytics);
  });

  it('stores each connection encrypted under its own key, with its own account', async () => {
    const getToken = mockGoogle({
      'code-gtm': {
        email: 'gtm@example.com',
        refreshToken: 'rt-gtm',
        scope: GOOGLE_SCOPES.gtmRead,
      },
      'code-yt': { email: 'second@example.com', refreshToken: 'rt-yt' },
    });
    const { google, kv } = setup();
    await google.get('gtm').completeConsent('code-gtm', REDIRECT, 'verifier-gtm');
    await google.get('youtube').completeConsent('code-yt', REDIRECT, 'verifier-yt');

    expect(getToken).toHaveBeenCalledWith({
      code: 'code-gtm',
      codeVerifier: 'verifier-gtm',
      redirect_uri: REDIRECT,
    });
    expect(kv.get('google.oauth.gtm')).not.toContain('rt-gtm');
    expect(stored(kv, 'gtm')).toMatchObject({ refreshToken: 'rt-gtm', email: 'gtm@example.com' });
    expect(stored(kv, 'youtube')).toMatchObject({
      refreshToken: 'rt-yt',
      email: 'second@example.com',
    });
    expect(kv.get(LEGACY_KV_KEY)).toBeUndefined();

    expect(google.get('gtm').status()).toMatchObject({
      connected: true,
      identity: 'gtm@example.com',
    });
    expect(google.get('merchant').status().connected).toBe(false);
  });

  it('only accepts the Google accounts allowed for that MCP', async () => {
    mockGoogle({
      stranger: { email: 'stranger@example.com', refreshToken: 'rt' },
      owner: { email: 'owner@example.com', refreshToken: 'rt-owner' },
    });
    const { google, kv } = setup();
    await expect(google.get('youtube').completeConsent('stranger', REDIRECT, 'v')).rejects.toThrow(
      /not allowed for the YouTube Analytics MCP/,
    );
    // GOOGLE_OWNER_EMAIL_GTM replaces the shared list for GTM.
    await expect(google.get('gtm').completeConsent('owner', REDIRECT, 'v')).rejects.toThrow(
      /allowed: gtm@example.com/,
    );
    await google.get('merchant').completeConsent('owner', REDIRECT, 'v');
    expect(kv.get('google.oauth.youtube')).toBeUndefined();
    expect(kv.get('google.oauth.gtm')).toBeUndefined();
    expect(stored(kv, 'merchant').email).toBe('owner@example.com');
  });

  it('gives every MCP its own client and token; unconnected MCPs fail on their own', async () => {
    mockGoogle({
      a: { email: 'gtm@example.com', refreshToken: 'rt-gtm' },
      b: { email: 'owner@example.com', refreshToken: 'rt-sa' },
    });
    const { google } = setup();
    await google.get('gtm').completeConsent('a', REDIRECT, 'v');
    await google.get('search-analytics').completeConsent('b', REDIRECT, 'v');
    const gtm = (await google.get('gtm').getClient()) as OAuth2Client;
    const sa = (await google.get('search-analytics').getClient()) as OAuth2Client;
    expect(gtm).not.toBe(sa);
    expect(gtm.credentials.refresh_token).toBe('rt-gtm');
    expect(sa.credentials.refresh_token).toBe('rt-sa');
    await expect(google.get('youtube').getClient()).rejects.toThrow(GoogleNotConnectedError);
    await expect(google.get('youtube').getClient()).rejects.toThrow(/YouTube Analytics MCP/);
  });

  it('persists a rotated refresh token only for the connection that refreshed', async () => {
    mockGoogle({
      a: { email: 'gtm@example.com', refreshToken: 'rt-gtm' },
      b: { email: 'owner@example.com', refreshToken: 'rt-yt' },
    });
    const { google, kv } = setup();
    await google.get('gtm').completeConsent('a', REDIRECT, 'v');
    await google.get('youtube').completeConsent('b', REDIRECT, 'v');
    const client = (await google.get('gtm').getClient()) as OAuth2Client;
    client.emit('tokens', { access_token: 'at', refresh_token: 'rt-gtm-rotated' });
    expect(stored(kv, 'gtm').refreshToken).toBe('rt-gtm-rotated');
    expect(stored(kv, 'youtube').refreshToken).toBe('rt-yt');
    // An access-token-only refresh changes nothing.
    client.emit('tokens', { access_token: 'at2' });
    expect(stored(kv, 'gtm').refreshToken).toBe('rt-gtm-rotated');
  });

  it('disconnects one MCP without touching the others or the shared record', async () => {
    mockGoogle({ a: { email: 'owner@example.com', refreshToken: 'rt-new' } });
    const { google, kv } = setup({ GOOGLE_OWNER_EMAIL_GTM: '' });
    kv.set(
      LEGACY_KV_KEY,
      new Encryptor(KEY).encrypt(
        JSON.stringify({
          refreshToken: 'rt-shared',
          scopes: [],
          email: 'owner@example.com',
          connectedAt: '2026-01-01',
        }),
      ),
    );
    const legacy = kv.get(LEGACY_KV_KEY);
    expect(google.migrateShared()).toContain('gtm');
    await google.get('youtube').completeConsent('a', REDIRECT, 'v');

    google.get('gtm').disconnect();
    expect(google.get('gtm').status().connected).toBe(false);
    expect(google.get('search-analytics').status().connected).toBe(true);
    expect(stored(kv, 'youtube').refreshToken).toBe('rt-new');
    expect(kv.get(LEGACY_KV_KEY)).toBe(legacy);

    // A restart must not re-import the shared connection into the MCP that was disconnected.
    const restarted = new GoogleConnections(
      testConfig({ GOOGLE_OWNER_EMAIL: 'owner@example.com' }),
      kv,
      new Encryptor(KEY),
    );
    expect(restarted.migrateShared()).toEqual([]);
    expect(restarted.get('gtm').status().connected).toBe(false);

    // Reconnecting later clears the disconnected marker.
    mockGoogle({ b: { email: 'owner@example.com', refreshToken: 'rt-gtm' } });
    await restarted.get('gtm').completeConsent('b', REDIRECT, 'v');
    expect(kv.get('google.oauth.gtm.disconnected')).toBeUndefined();
  });

  describe('migration from the shared connection', () => {
    const seedLegacy = (kv: KvStore) => {
      const ciphertext = new Encryptor(KEY).encrypt(
        JSON.stringify({
          refreshToken: 'rt-shared',
          scopes: [GOOGLE_SCOPES.gscRead, GOOGLE_SCOPES.gaRead],
          email: 'owner@example.com',
          connectedAt: '2026-01-01T00:00:00.000Z',
        }),
      );
      kv.set(LEGACY_KV_KEY, ciphertext);
      return ciphertext;
    };

    it('copies the shared connection to every MCP without changing it, and is idempotent', () => {
      const { google, kv } = setup({ GOOGLE_OWNER_EMAIL_GTM: '' });
      const legacy = seedLegacy(kv);
      expect(google.migrateShared()).toEqual(['search-analytics', 'gtm', 'youtube', 'merchant']);
      for (const c of google.all()) {
        expect(c.status()).toMatchObject({
          connected: true,
          identity: 'owner@example.com',
          migratedFromShared: true,
        });
        expect(stored(kv, c.id).refreshToken).toBe('rt-shared');
      }
      // The shared record is untouched (byte for byte), so a rollback to the previous version still works.
      expect(kv.get(LEGACY_KV_KEY)).toBe(legacy);
      expect(JSON.parse(new Encryptor(KEY).decrypt(kv.get(LEGACY_KV_KEY)!)).refreshToken).toBe(
        'rt-shared',
      );
      expect(google.migrateShared()).toEqual([]);
    });

    it('skips an MCP pinned to other accounts, leaving it to be connected on /setup', () => {
      const { google, kv } = setup();
      seedLegacy(kv);
      expect(google.migrateShared()).toEqual(['search-analytics', 'youtube', 'merchant']);
      expect(google.get('gtm').status().connected).toBe(false);
      expect(kv.get('google.oauth.gtm')).toBeUndefined();
    });

    it('never overwrites a connection that already has its own account', async () => {
      mockGoogle({ a: { email: 'gtm@example.com', refreshToken: 'rt-gtm' } });
      const { google, kv } = setup();
      await google.get('gtm').completeConsent('a', REDIRECT, 'v');
      seedLegacy(kv);
      expect(google.migrateShared()).toEqual(['search-analytics', 'youtube', 'merchant']);
      expect(stored(kv, 'gtm')).toMatchObject({ refreshToken: 'rt-gtm', email: 'gtm@example.com' });
      expect(stored(kv, 'gtm').migratedFromShared).toBeUndefined();
    });

    it('reports scopes the shared grant lacks for each MCP', () => {
      const { google, kv } = setup({ GOOGLE_OWNER_EMAIL_GTM: '' });
      seedLegacy(kv);
      google.migrateShared();
      expect(google.get('search-analytics').status().missingScopes).toEqual([]);
      expect(google.get('gtm').status().missingScopes).toEqual([GOOGLE_SCOPES.gtmRead]);
    });

    it('does nothing in service-account mode', () => {
      const kv = new KvStore(openDb(':memory:'));
      seedLegacy(kv);
      const config: Config = testConfig({
        GOOGLE_AUTH_MODE: 'service_account',
        GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
          client_email: 'sa@p.iam.gserviceaccount.com',
          private_key: 'k',
        }),
        GOOGLE_SERVICE_ACCOUNT_JSON_GTM: JSON.stringify({
          client_email: 'gtm-sa@p.iam.gserviceaccount.com',
          private_key: 'k',
        }),
      });
      const google = new GoogleConnections(config, kv, new Encryptor(KEY));
      expect(google.migrateShared()).toEqual([]);
      expect(google.get('gtm').status().identity).toBe('gtm-sa@p.iam.gserviceaccount.com');
      expect(google.get('youtube').status().identity).toBe('sa@p.iam.gserviceaccount.com');
    });
  });

  it('handles concurrent connections finishing in any order', async () => {
    mockGoogle({
      gtm: { email: 'gtm@example.com', refreshToken: 'rt-gtm' },
      yt: { email: 'owner@example.com', refreshToken: 'rt-yt' },
      merchant: { email: 'second@example.com', refreshToken: 'rt-m' },
    });
    const { google, kv } = setup();
    await Promise.all([
      google.get('merchant').completeConsent('merchant', REDIRECT, 'v3'),
      google.get('youtube').completeConsent('yt', REDIRECT, 'v2'),
      google.get('gtm').completeConsent('gtm', REDIRECT, 'v1'),
    ]);
    expect(stored(kv, 'gtm').refreshToken).toBe('rt-gtm');
    expect(stored(kv, 'youtube').refreshToken).toBe('rt-yt');
    expect(stored(kv, 'merchant').refreshToken).toBe('rt-m');
  });

  it("hands each MCP's tools only that MCP's API clients", async () => {
    const config = testConfig();
    const apisFor = vi.fn(() => async () => ({}) as GoogleApis);
    const deps = {
      config,
      apisFor,
      policy: new AccessPolicy(config),
      audit: new AuditLog(undefined),
    };
    buildMcpServer(deps, { scopes: ['mcp:read'], actor: 't' }, getConnector('gtm'));
    buildMcpServer(deps, { scopes: ['mcp:read'], actor: 't' }, getConnector('merchant'));
    expect(apisFor.mock.calls).toEqual([['gtm'], ['merchant']]);
  });
});
