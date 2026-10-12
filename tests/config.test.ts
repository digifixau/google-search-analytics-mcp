import { describe, expect, it } from 'vitest';
import { ConfigError, parseApiKeys } from '../src/config.js';
import { missingScopes, requiredGoogleScopes, GOOGLE_SCOPES } from '../src/google/auth.js';
import { testConfig } from './helpers.js';

describe('config', () => {
  it('defaults to read-only stdio with all write toolsets listed', () => {
    const c = testConfig();
    expect(c.accessMode).toBe('readonly');
    expect(c.transport).toBe('stdio');
    expect(c.writeToolsets).toEqual(['gsc', 'indexing', 'ga4_admin', 'ga4_audiences_streams']);
  });

  it('requires PUBLIC_URL (https) and ADMIN_PASSWORD for http', () => {
    expect(() => testConfig({ TRANSPORT: 'http' })).toThrow(ConfigError);
    expect(() =>
      testConfig({
        TRANSPORT: 'http',
        PUBLIC_URL: 'http://mcp.example.com',
        ADMIN_PASSWORD: 'a'.repeat(12),
      }),
    ).toThrow(/https/);
    expect(
      testConfig({
        TRANSPORT: 'http',
        PUBLIC_URL: 'https://mcp.example.com/',
        ADMIN_PASSWORD: 'a'.repeat(12),
      }).publicUrl?.href,
    ).toBe('https://mcp.example.com/');
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
    ]);
    const rw = requiredGoogleScopes(
      testConfig({ ACCESS_MODE: 'readwrite', WRITE_TOOLSETS: 'ga4_admin' }),
    );
    expect(rw).toEqual([GOOGLE_SCOPES.gscRead, GOOGLE_SCOPES.gaRead, GOOGLE_SCOPES.gaEdit]);
  });

  it('treats webmasters as a superset of webmasters.readonly', () => {
    expect(missingScopes([GOOGLE_SCOPES.gscRead], [GOOGLE_SCOPES.gscWrite])).toEqual([]);
    expect(missingScopes([GOOGLE_SCOPES.indexing], [GOOGLE_SCOPES.gscWrite])).toEqual([
      GOOGLE_SCOPES.indexing,
    ]);
  });
});
