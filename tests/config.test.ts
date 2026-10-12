import { describe, expect, it } from 'vitest';
import { allowedEmailsFor, ConfigError, parseApiKeys, serviceAccountFor } from '../src/config.js';
import { missingScopes, requiredGoogleScopes, GOOGLE_SCOPES } from '../src/google/auth.js';
import { testConfig } from './helpers.js';

describe('config', () => {
  it('defaults to read-only stdio with all write toolsets listed', () => {
    const c = testConfig();
    expect(c.accessMode).toBe('readonly');
    expect(c.transport).toBe('stdio');
    expect(c.writeToolsets).toEqual([
      'gsc',
      'indexing',
      'ga4_admin',
      'ga4_audiences_streams',
      'gtm',
      'gtm_publish',
      'youtube',
      'merchant',
    ]);
    expect(c.enabledServices).toEqual(['gsc', 'ga4', 'gtm', 'youtube', 'merchant', 'places']);
  });

  it('requires PUBLIC_URL (https) and ADMIN_PASSWORD for http', () => {
    const http = {
      TRANSPORT: 'http',
      PUBLIC_URL: 'https://mcp.example.com/',
      ADMIN_PASSWORD: 'a'.repeat(16),
      GOOGLE_OWNER_EMAIL: 'Owner@Example.com',
    };
    expect(() => testConfig({ TRANSPORT: 'http' })).toThrow(ConfigError);
    expect(() => testConfig({ ...http, PUBLIC_URL: 'http://mcp.example.com' })).toThrow(/https/);
    expect(testConfig(http).publicUrl?.href).toBe('https://mcp.example.com/');
    expect(testConfig(http).google.ownerEmails).toEqual(['owner@example.com']);
  });

  it('enforces a 16+ character admin password for http', () => {
    const http = {
      TRANSPORT: 'http',
      PUBLIC_URL: 'https://mcp.example.com',
      GOOGLE_OWNER_EMAIL: 'owner@example.com',
    };
    expect(() => testConfig({ ...http, ADMIN_PASSWORD: 'a'.repeat(15) })).toThrow(/16 characters/);
    expect(() => testConfig({ ...http, ADMIN_PASSWORD: 'a'.repeat(16) })).not.toThrow();
  });

  it('requires GOOGLE_OWNER_EMAIL for remote oauth deployments only', () => {
    const http = {
      TRANSPORT: 'http',
      PUBLIC_URL: 'https://mcp.example.com',
      ADMIN_PASSWORD: 'a'.repeat(16),
    };
    expect(() => testConfig(http)).toThrow(/GOOGLE_OWNER_EMAIL/);
    // stdio (local) use does not need it
    expect(() => testConfig({ TRANSPORT: 'stdio' })).not.toThrow();
  });

  it('allows a list of Google accounts with per-MCP overrides', () => {
    const http = {
      TRANSPORT: 'http',
      PUBLIC_URL: 'https://mcp.example.com',
      ADMIN_PASSWORD: 'a'.repeat(16),
    };
    const c = testConfig({
      ...http,
      GOOGLE_OWNER_EMAIL: 'Owner@Example.com, agency@example.com',
      GOOGLE_OWNER_EMAIL_GTM: 'tags@example.com',
      GOOGLE_OWNER_EMAIL_SEARCH_ANALYTICS: ' ',
    });
    expect(allowedEmailsFor(c, 'search-analytics')).toEqual([
      'owner@example.com',
      'agency@example.com',
    ]);
    expect(allowedEmailsFor(c, 'gtm')).toEqual(['tags@example.com']);

    // Every enabled MCP needs an allowed account: overrides alone must cover them all.
    expect(() => testConfig({ ...http, GOOGLE_OWNER_EMAIL_GTM: 'tags@example.com' })).toThrow(
      /GOOGLE_OWNER_EMAIL_<MCP> for: SEARCH_ANALYTICS, YOUTUBE, MERCHANT/,
    );
    expect(() =>
      testConfig({
        ...http,
        ENABLED_SERVICES: 'gtm',
        GOOGLE_OWNER_EMAIL_GTM: 'tags@example.com',
      }),
    ).not.toThrow();
    expect(() =>
      testConfig({
        ...http,
        GOOGLE_OWNER_EMAIL: 'a@example.com',
        GOOGLE_OWNER_EMAIL_TAGS: 'x@y.z',
      }),
    ).toThrow(/Unknown MCP in GOOGLE_OWNER_EMAIL_TAGS/);
  });

  it('treats Places as an API-key MCP with no Google account settings', () => {
    // A missing key must not stop an existing deployment from starting after an upgrade.
    expect(() => testConfig()).not.toThrow();
    expect(testConfig({ GOOGLE_PLACES_API_KEY: 'abc' }).google.placesApiKey).toBe('abc');
    // No account, client or encryption settings are needed when only Places is enabled.
    expect(() =>
      testConfig({
        ENABLED_SERVICES: 'places',
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
        ENCRYPTION_KEY: '',
      }),
    ).not.toThrow();
    expect(() =>
      testConfig({
        TRANSPORT: 'http',
        PUBLIC_URL: 'https://mcp.example.com',
        ADMIN_PASSWORD: 'a'.repeat(16),
        ENABLED_SERVICES: 'places',
      }),
    ).not.toThrow();
    // Places has no Google account, so per-MCP account overrides for it are rejected.
    expect(() => testConfig({ GOOGLE_OWNER_EMAIL_PLACES: 'x@example.com' })).toThrow(
      /Unknown MCP in GOOGLE_OWNER_EMAIL_PLACES/,
    );
    expect(() =>
      testConfig({ GOOGLE_AUTH_MODE: 'service_account', ENABLED_SERVICES: 'places' }),
    ).not.toThrow();
    // Places never requests Google OAuth scopes.
    expect(requiredGoogleScopes(testConfig({ ENABLED_SERVICES: 'places' }))).toEqual([]);
  });

  it('accepts a service account key per MCP', () => {
    const sa = { GOOGLE_AUTH_MODE: 'service_account', ENABLED_SERVICES: 'gsc,ga4,gtm' };
    expect(() => testConfig({ ...sa, GOOGLE_SERVICE_ACCOUNT_JSON_GTM: '/keys/gtm.json' })).toThrow(
      /SEARCH_ANALYTICS/,
    );
    const c = testConfig({
      ...sa,
      GOOGLE_SERVICE_ACCOUNT_JSON: '/keys/shared.json',
      GOOGLE_SERVICE_ACCOUNT_JSON_GTM: '/keys/gtm.json',
    });
    expect(serviceAccountFor(c, 'gtm')).toBe('/keys/gtm.json');
    expect(serviceAccountFor(c, 'search-analytics')).toBe('/keys/shared.json');
  });

  it('rejects unknown write toolsets and missing Google credentials', () => {
    expect(() => testConfig({ WRITE_TOOLSETS: 'gsc,nope' })).toThrow(/nope/);
    expect(() => testConfig({ GOOGLE_CLIENT_ID: '' })).toThrow(/GOOGLE_CLIENT_ID/);
    expect(() => testConfig({ GOOGLE_AUTH_MODE: 'service_account' })).toThrow(/SERVICE_ACCOUNT/);
  });

  it('parses API keys with labels and scopes', () => {
    const keys = parseApiKeys(
      'cli=aaaaaaaaaaaaaaaaaaaaaaaaaaaa:read+write,bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    expect(keys).toEqual([
      { label: 'cli', key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa', scopes: ['mcp:read', 'mcp:write'] },
      { label: 'api-key-2', key: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbb', scopes: ['mcp:read'] },
    ]);
    expect(() => parseApiKeys('short:read')).toThrow(/24/);
  });

  it('requests only read Google scopes in read-only mode', () => {
    expect(requiredGoogleScopes(testConfig())).toEqual([
      GOOGLE_SCOPES.gscRead,
      GOOGLE_SCOPES.gaRead,
      GOOGLE_SCOPES.gtmRead,
      GOOGLE_SCOPES.ytAnalytics,
      GOOGLE_SCOPES.ytMonetary,
      GOOGLE_SCOPES.ytRead,
      // The Merchant API has no read-only scope.
      GOOGLE_SCOPES.merchant,
    ]);
    const rw = requiredGoogleScopes(
      testConfig({
        ACCESS_MODE: 'readwrite',
        WRITE_TOOLSETS: 'ga4_admin',
        ENABLED_SERVICES: 'gsc,ga4',
      }),
    );
    expect(rw).toEqual([GOOGLE_SCOPES.gscRead, GOOGLE_SCOPES.gaRead, GOOGLE_SCOPES.gaEdit]);
  });

  it('swaps youtube.readonly for the manage scope only when YouTube edits are on', () => {
    const rw = requiredGoogleScopes(
      testConfig({ ACCESS_MODE: 'readwrite', ENABLED_SERVICES: 'youtube' }),
    );
    expect(rw).toEqual([
      GOOGLE_SCOPES.ytAnalytics,
      GOOGLE_SCOPES.ytMonetary,
      GOOGLE_SCOPES.ytManage,
    ]);
    expect(missingScopes([GOOGLE_SCOPES.ytRead], [GOOGLE_SCOPES.ytManage])).toEqual([]);
    const noEdits = requiredGoogleScopes(
      testConfig({ ACCESS_MODE: 'readwrite', ENABLED_SERVICES: 'youtube', WRITE_TOOLSETS: 'gsc' }),
    );
    expect(noEdits).toContain(GOOGLE_SCOPES.ytRead);
    expect(noEdits).not.toContain(GOOGLE_SCOPES.ytManage);
  });

  it('requests GTM edit and publish scopes only when those toolsets are on', () => {
    const all = requiredGoogleScopes(testConfig({ ACCESS_MODE: 'readwrite' }));
    expect(all).toEqual(
      expect.arrayContaining([
        GOOGLE_SCOPES.gtmRead,
        GOOGLE_SCOPES.gtmEdit,
        GOOGLE_SCOPES.gtmVersions,
        GOOGLE_SCOPES.gtmPublish,
      ]),
    );
    const noPublish = requiredGoogleScopes(
      testConfig({ ACCESS_MODE: 'readwrite', WRITE_TOOLSETS: 'gtm' }),
    );
    expect(noPublish).toContain(GOOGLE_SCOPES.gtmEdit);
    expect(noPublish).not.toContain(GOOGLE_SCOPES.gtmPublish);
    expect(
      requiredGoogleScopes(
        testConfig({ ACCESS_MODE: 'readwrite', ENABLED_SERVICES: 'gsc,ga4' }),
      ).some((s) => s.includes('tagmanager')),
    ).toBe(false);
    expect(() => testConfig({ ENABLED_SERVICES: 'gsc,ads' })).toThrow(/ads/);
  });

  it('treats webmasters as a superset of webmasters.readonly', () => {
    expect(missingScopes([GOOGLE_SCOPES.gscRead], [GOOGLE_SCOPES.gscWrite])).toEqual([]);
    expect(missingScopes([GOOGLE_SCOPES.indexing], [GOOGLE_SCOPES.gscWrite])).toEqual([
      GOOGLE_SCOPES.indexing,
    ]);
  });
});
