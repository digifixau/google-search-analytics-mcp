import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OAuth2Client } from 'google-auth-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppContext } from '../src/app.js';
import { dashboardPage } from '../src/auth/pages.js';
import { LEGACY_KV_KEY } from '../src/google/auth.js';
import type { GoogleApis } from '../src/google/clients.js';
import { getConnector } from '../src/mcp/connectors.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { describeError, isRevokedGoogleToken } from '../src/util/errors.js';
import { testConfig, text } from './helpers.js';

const REDIRECT = 'https://mcp.example.com/oauth/google/callback';

/** What google-auth-library throws when Google refuses a refresh token. */
const revoked = () =>
  Object.assign(new Error('invalid_grant'), {
    response: {
      status: 400,
      data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
    },
  });

afterEach(() => vi.restoreAllMocks());

describe('expired or revoked Google tokens', () => {
  it('turns Google\'s "Token has been expired or revoked" into a reconnect instruction', () => {
    for (const error of [
      revoked(),
      new Error('invalid_grant'),
      {
        response: {
          status: 400,
          data: {
            error: 'invalid_grant',
            error_description: 'reauth related error (invalid_rapt)',
          },
        },
      },
    ]) {
      expect(isRevokedGoogleToken(error)).toBe(true);
      const message = describeError(error);
      expect(message).toContain('click Reconnect');
      expect(message).toContain('/setup');
      expect(message).not.toContain('(400)');
    }
    // Ordinary API errors are not mistaken for a dead token.
    const notFound = { response: { status: 404, data: { error: { message: 'Not found' } } } };
    expect(isRevokedGoogleToken(notFound)).toBe(false);
    expect(describeError(notFound)).toContain('Not found (404)');
  });

  it('flags only the affected MCP on /setup, keeps its token, and clears the flag on reconnect', async () => {
    vi.spyOn(OAuth2Client.prototype, 'getToken').mockImplementation((async (opts: {
      code: string;
    }) => ({
      tokens: { refresh_token: `rt-${opts.code}`, id_token: `id-${opts.code}`, scope: '' },
    })) as never);
    vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockImplementation((async () => ({
      getPayload: () => ({ email: 'owner@example.com', email_verified: true }),
    })) as never);
    const app = createAppContext(testConfig({ GOOGLE_OWNER_EMAIL: 'owner@example.com' }));
    app.kv.set(LEGACY_KV_KEY, 'legacy-ciphertext');
    await app.google.get('search-analytics').completeConsent('sa', REDIRECT, 'v');
    await app.google.get('gtm').completeConsent('gtm', REDIRECT, 'v');
    const storedBefore = app.kv.get('google.oauth.search-analytics');

    const listSites = vi.fn().mockRejectedValue(revoked());
    const apis = { searchconsole: { sites: { list: listSites } } } as unknown as GoogleApis;
    const server = buildMcpServer(
      { ...app, apisFor: () => async () => apis },
      { scopes: ['mcp:read'], actor: 'test' },
      getConnector('search-analytics'),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await client.callTool({ name: 'gsc_list_sites', arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('click Reconnect');

    const sa = app.google.get('search-analytics').status();
    expect(sa.connected).toBe(true);
    expect(sa.tokenRejectedAt).toBeDefined();
    expect(app.google.get('gtm').status().tokenRejectedAt).toBeUndefined();
    // Nothing is deleted: the stored token and the legacy record stay as they were.
    expect(app.kv.get('google.oauth.search-analytics')).toBe(storedBefore);
    expect(app.kv.get(LEGACY_KV_KEY)).toBe('legacy-ciphertext');

    // The first time is kept on repeated failures.
    const firstSeen = sa.tokenRejectedAt;
    await client.callTool({ name: 'gsc_list_sites', arguments: {} });
    expect(app.google.get('search-analytics').status().tokenRejectedAt).toBe(firstSeen);

    const page = dashboardPage({
      csrf: 'c',
      connections: [{ url: 'https://mcp.example.com/mcp', tools: '24', google: sa }],
      accessMode: 'readonly',
      writeToolsets: [],
      clients: [],
      audit: [],
    });
    expect(page).toContain('Google no longer accepts the saved sign-in for owner@example.com');
    expect(page).toContain('Reconnect');

    await app.google.get('search-analytics').completeConsent('sa2', REDIRECT, 'v');
    expect(app.google.get('search-analytics').status().tokenRejectedAt).toBeUndefined();
  });
});
