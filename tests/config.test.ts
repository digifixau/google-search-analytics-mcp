import { describe, expect, it } from 'vitest';
import { ConfigError, parseApiKeys } from '../src/config.js';
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
    ]);
    expect(c.enabledServices).toEqual(['gsc', 'ga4', 'gtm']);
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
    expect(testConfig(http).google.ownerEmail).toBe('owner@example.com');
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
    ]);
    const rw = requiredGoogleScopes(
      testConfig({ ACCESS_MODE: 'readwrite', WRITE_TOOLSETS: 'ga4_admin' }),
    );
    expect(rw).toEqual([
      GOOGLE_SCOPES.gscRead,
      GOOGLE_SCOPES.gaRead,
      GOOGLE_SCOPES.gaEdit,
      GOOGLE_SCOPES.gtmRead,
    ]);
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
