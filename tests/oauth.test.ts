import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Response } from 'express';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { OwnerOAuthProvider } from '../src/auth/provider.js';
import { openDb } from '../src/store/db.js';
import { testConfig } from './helpers.js';

function setup(mode: 'readonly' | 'readwrite' = 'readwrite') {
  const config = testConfig({
    TRANSPORT: 'http',
    PUBLIC_URL: 'https://mcp.example.com',
    ADMIN_PASSWORD: 'correct-horse-battery',
    ACCESS_MODE: mode,
    MCP_API_KEYS: 'ci=abcdefghijklmnopqrstuvwxyz0123:read',
  });
  const provider = new OwnerOAuthProvider(config, openDb(':memory:'));
  const client = provider.clientsStore.registerClient({
    client_id: 'client-1',
    client_name: 'Claude',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    token_endpoint_auth_method: 'none',
  } as OAuthClientInformationFull);
  return { provider, client };
}

function fakeRes() {
  const res = {
    body: '',
    status: () => res,
    set: () => res,
    send: (b: string) => ((res.body = b), res),
  };
  return res as unknown as Response & { body: string };
}

async function startAuth(
  provider: OwnerOAuthProvider,
  client: OAuthClientInformationFull,
  scopes: string[] = [],
) {
  const res = fakeRes();
  const verifier = 'v'.repeat(50);
  const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
  await provider.authorize(
    client,
    { scopes, codeChallenge, redirectUri: client.redirect_uris[0]!.toString(), state: 's1' },
    res,
  );
  const requestId = /name="request_id" value="([^"]+)"/.exec(res.body)![1]!;
  return { requestId, html: res.body, codeChallenge };
}

describe('OwnerOAuthProvider', () => {
  it('rejects non-https redirect URIs at registration', () => {
    const { provider } = setup();
    expect(() =>
      provider.clientsStore.registerClient({
        client_id: 'x',
        redirect_uris: ['http://evil.com/cb'],
      } as unknown as OAuthClientInformationFull),
    ).toThrow(/https/);
  });

  it('issues read-only tokens unless the owner ticks write', async () => {
    const { provider, client } = setup();
    const { requestId, codeChallenge, html } = await startAuth(provider, client);
    expect(html).toContain('Make changes (write)');

    const wrong = provider.handleConsent(
      { request_id: requestId, password: 'nope', decision: 'approve' },
      '1.1.1.1',
    );
    expect(wrong.kind).toBe('page');

    const ok = provider.handleConsent(
      { request_id: requestId, password: 'correct-horse-battery', decision: 'approve' },
      '1.1.1.1',
    );
    expect(ok.kind).toBe('redirect');
    const location = new URL((ok as { location: string }).location);
    expect(location.searchParams.get('state')).toBe('s1');
    const code = location.searchParams.get('code')!;

    expect(await provider.challengeForAuthorizationCode(client, code)).toBe(codeChallenge);
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    expect(tokens.scope).toBe('mcp:read');
    await expect(provider.exchangeAuthorizationCode(client, code)).rejects.toThrow(/Invalid/);

    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.scopes).toEqual(['mcp:read']);
    expect(info.resource?.href).toBe('https://mcp.example.com/mcp');

    const refreshed = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow(
      /Invalid/,
    );
    await expect(
      provider.exchangeRefreshToken(client, refreshed.refresh_token!, ['mcp:read', 'mcp:write']),
    ).rejects.toThrow(/exceed/);
  });

  it('grants write when ticked on a read-write server, never on a read-only one', async () => {
    for (const [mode, expected] of [
      ['readwrite', 'mcp:read mcp:write'],
      ['readonly', 'mcp:read'],
    ] as const) {
      const { provider, client } = setup(mode);
      const { requestId, html } = await startAuth(provider, client, ['mcp:read', 'mcp:write']);
      expect(html.includes('Make changes (write)')).toBe(mode === 'readwrite');
      const ok = provider.handleConsent(
        {
          request_id: requestId,
          password: 'correct-horse-battery',
          decision: 'approve',
          scope_write: '1',
        },
        'ip',
      );
      const code = new URL((ok as { location: string }).location).searchParams.get('code')!;
      expect((await provider.exchangeAuthorizationCode(client, code)).scope).toBe(expected);
    }
  });

  it('redirects with access_denied when the owner denies', async () => {
    const { provider, client } = setup();
    const { requestId } = await startAuth(provider, client);
    const out = provider.handleConsent({ request_id: requestId, decision: 'deny' }, 'ip');
    expect((out as { location: string }).location).toContain('error=access_denied');
  });

  it('rejects foreign resources and unknown scopes', async () => {
    const { provider, client } = setup();
    await expect(
      provider.authorize(
        client,
        {
          codeChallenge: 'c',
          redirectUri: 'https://claude.ai/api/mcp/auth_callback',
          resource: new URL('https://other.com/mcp'),
        },
        fakeRes(),
      ),
    ).rejects.toThrow(/resource/);
    await expect(startAuth(provider, client, ['admin'])).rejects.toThrow(/Unsupported scope/);
  });

  it('accepts static API keys and rate-limits password guessing', async () => {
    const { provider } = setup();
    expect((await provider.verifyAccessToken('abcdefghijklmnopqrstuvwxyz0123')).clientId).toBe(
      'api-key:ci',
    );
    await expect(provider.verifyAccessToken('nope')).rejects.toThrow();
    for (let i = 0; i < 10; i++) provider.recordFailure('9.9.9.9');
    expect(provider.checkRateLimit('9.9.9.9')).toBe(false);
    expect(provider.checkRateLimit('8.8.8.8')).toBe(true);
  });
});
