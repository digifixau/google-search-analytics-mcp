import express, { type NextFunction, type Request, type Response } from 'express';
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AppContext } from '../app.js';
import { MCP_SCOPES } from '../config.js';
import { OwnerOAuthProvider } from '../auth/provider.js';
import { dashboardPage, loginPage, messagePage, redirectPage } from '../auth/pages.js';
import {
  comparableResource,
  connectorUrl,
  enabledConnectors,
  type ConnectorDef,
} from '../mcp/connectors.js';
import { buildMcpServer, SERVER_NAME, SERVER_VERSION, toolInConnector } from '../mcp/server.js';
import { allTools } from '../tools/index.js';
import { isToolEnabled } from '../tools/registry.js';
import { OAuth2Client } from 'google-auth-library';
import { randomToken, sha256 } from '../store/crypto.js';

const SESSION_COOKIE = 'gsa_setup';
const SESSION_TTL_MS = 30 * 60 * 1000;

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'",
};

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function createHttpApp(app: AppContext): express.Express {
  const { config } = app;
  const publicUrl = config.publicUrl!;
  const provider = new OwnerOAuthProvider(config, app.db);
  const connectors = enabledConnectors(config);
  if (connectors.length === 0) throw new Error('ENABLED_SERVICES leaves no MCP endpoint enabled');
  const scopesSupported =
    config.accessMode === 'readwrite' ? [MCP_SCOPES.read, MCP_SCOPES.write] : [MCP_SCOPES.read];
  const sessions = new Map<string, { csrf: string; expiresAt: number }>();
  /** Pending Google consents, keyed by sha256(state): which MCP, PKCE verifier, and the setup session that started it. */
  const googleStates = new Map<
    string,
    { connectionId: string; codeVerifier: string; sessionId: string; expiresAt: number }
  >();

  const server = express();
  server.disable('x-powered-by');
  server.set('trust proxy', config.trustProxy ? 1 : false);

  const html = (res: Response, status: number, body: string) =>
    res.status(status).set(HTML_HEADERS).send(body);

  server.get('/healthz', (_req, res) => {
    res.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION });
  });

  server.get('/', (_req, res) => {
    res.json({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      mcp: Object.fromEntries(connectors.map((c) => [c.id, connectorUrl(c, publicUrl).href])),
      accessMode: config.accessMode,
      setup: new URL('/setup', publicUrl).href,
    });
  });

  // OAuth 2.1 authorization server + protected resource metadata (RFC 8414 / RFC 9728).
  server.use(
    mcpAuthRouter({
      provider,
      issuerUrl: publicUrl,
      baseUrl: publicUrl,
      // The SDK advertises one protected resource; the other connectors are added below.
      resourceServerUrl: connectorUrl(connectors[0]!, publicUrl),
      scopesSupported,
      resourceName: `${connectors[0]!.title} MCP`,
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }),
  );

  const form = express.urlencoded({ extended: false, limit: '16kb' });

  server.post('/oauth/consent', form, (req, res) => {
    const outcome = provider.handleConsent(req.body ?? {}, req.ip ?? 'unknown');
    if (outcome.kind === 'redirect') {
      html(res, 200, redirectPage(outcome.location, outcome.approved));
    } else {
      html(res, outcome.status, outcome.html);
    }
  });

  // ---- MCP endpoints (stateless Streamable HTTP), one per connector ----
  const hostCheck = hostHeaderValidation([publicUrl.hostname, 'localhost', '127.0.0.1']);
  const methodNotAllowed = (_req: Request, res: Response) => {
    res
      .status(405)
      .set('Allow', 'POST')
      .json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed (stateless server)' },
        id: null,
      });
  };

  const mountConnector = (connector: ConnectorDef, index: number) => {
    const url = connectorUrl(connector, publicUrl);
    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(url);

    if (index > 0) {
      // RFC 9728 metadata for the extra endpoints (the first one is served by mcpAuthRouter).
      server.get(new URL(resourceMetadataUrl).pathname, (_req, res) => {
        res.json({
          resource: url.href,
          authorization_servers: [publicUrl.href],
          scopes_supported: scopesSupported,
          resource_name: `${connector.title} MCP`,
        });
      });
    }

    const bearer = requireBearerAuth({
      verifier: provider,
      requiredScopes: [MCP_SCOPES.read],
      resourceMetadataUrl,
    });
    // Tokens approved for another MCP endpoint are rejected; tokens without a resource work everywhere.
    const audience = (req: Request, res: Response, next: NextFunction) => {
      const resource = req.auth?.resource;
      if (resource && comparableResource(resource) !== comparableResource(url)) {
        res
          .status(401)
          .set(
            'WWW-Authenticate',
            `Bearer error="invalid_token", error_description="Token was issued for a different MCP endpoint", resource_metadata="${resourceMetadataUrl}"`,
          )
          .json({
            error: 'invalid_token',
            error_description: 'Token was issued for a different MCP endpoint',
          });
        return;
      }
      next();
    };

    server.post(
      connector.path,
      hostCheck,
      bearer,
      audience,
      express.json({ limit: '1mb' }),
      async (req, res) => {
        const auth = req.auth!;
        const mcp = buildMcpServer(app, { scopes: auth.scopes, actor: auth.clientId }, connector);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on('close', () => {
          void transport.close();
          void mcp.close();
        });
        try {
          await mcp.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (error) {
          console.error(`[mcp:${connector.id}] request failed`, error);
          if (!res.headersSent) {
            res.status(500).json({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error' },
              id: null,
            });
          }
        }
      },
    );
    server.get(connector.path, methodNotAllowed);
    server.delete(connector.path, methodNotAllowed);
  };
  connectors.forEach(mountConnector);

  // ---- Owner setup dashboard ----
  const getSession = (req: Request) => {
    const id = readCookie(req, SESSION_COOKIE);
    const session = id ? sessions.get(id) : undefined;
    if (!session || session.expiresAt < Date.now()) return undefined;
    return { id: id!, ...session };
  };
  const requireSession = (req: Request, res: Response, next: NextFunction) => {
    const session = getSession(req);
    if (!session || req.body?.csrf !== session.csrf) {
      html(res, 403, messagePage('Session expired', 'Please sign in again.'));
      return;
    }
    next();
  };
  const cookieAttrs = `Path=/; HttpOnly; SameSite=Lax${publicUrl.protocol === 'https:' ? '; Secure' : ''}`;

  server.get('/setup', (req, res) => {
    const session = getSession(req);
    if (!session) return html(res, 200, loginPage());
    const flashConnection =
      typeof req.query.connection === 'string' && app.google.has(req.query.connection)
        ? app.google.get(req.query.connection).title
        : undefined;
    const flash =
      req.query.connected === '1' && flashConnection
        ? `Google account connected to the ${flashConnection} MCP.`
        : req.query.disconnected === '1' && flashConnection
          ? `Google account disconnected from the ${flashConnection} MCP.`
          : req.query.revoked === '1'
            ? 'Client access revoked.'
            : undefined;
    html(
      res,
      200,
      dashboardPage({
        csrf: session.csrf,
        connections: connectors.map((c) => {
          const tools = allTools.filter((t) => toolInConnector(t, c));
          const count = (scopes: string[]) =>
            tools.filter((t) => isToolEnabled(t, config, scopes)).length;
          const rw = count([MCP_SCOPES.read, MCP_SCOPES.write]);
          const ro = count([MCP_SCOPES.read]);
          return {
            url: connectorUrl(c, publicUrl).href,
            tools: rw === ro ? `${ro}` : `${ro} read-only / ${rw} read+write`,
            google: app.google.get(c.id).status(),
          };
        }),
        accessMode: config.accessMode,
        writeToolsets: config.writeToolsets,
        clients: provider.listClients(),
        audit: app.audit.recent(20).map((a) => ({ ...a, ts: new Date(a.ts).toISOString() })),
        flash,
      }),
    );
  });

  server.post('/setup/login', form, (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (!provider.checkRateLimit(ip))
      return html(res, 429, loginPage('Too many attempts. Try again in 15 minutes.'));
    if (!provider.verifyPassword(req.body?.password)) {
      provider.recordFailure(ip);
      return html(res, 401, loginPage('Incorrect password.'));
    }
    const id = randomToken(32);
    sessions.set(id, { csrf: randomToken(24), expiresAt: Date.now() + SESSION_TTL_MS });
    res
      .set(
        'Set-Cookie',
        `${SESSION_COOKIE}=${id}; ${cookieAttrs}; Max-Age=${SESSION_TTL_MS / 1000}`,
      )
      .redirect(303, '/setup');
  });

  server.post('/setup/logout', form, requireSession, (req, res) => {
    const session = getSession(req);
    if (session) sessions.delete(session.id);
    res.set('Set-Cookie', `${SESSION_COOKIE}=; ${cookieAttrs}; Max-Age=0`).redirect(303, '/setup');
  });

  const googleRedirectUri = new URL('/oauth/google/callback', publicUrl).href;

  /** The MCP a setup form refers to; only enabled connectors are accepted. */
  const formConnection = (req: Request) => {
    const id = String(req.body?.connection ?? '');
    // API-key MCPs (Places) have no Google account to connect or disconnect.
    return app.google.has(id) && app.google.get(id).mode !== 'api_key'
      ? app.google.get(id)
      : undefined;
  };

  server.post('/setup/google/connect', form, requireSession, async (req, res) => {
    if (config.google.authMode !== 'oauth')
      return html(res, 400, messagePage('Not available', 'Service account mode needs no consent.'));
    const connection = formConnection(req);
    if (!connection)
      return html(res, 400, messagePage('Unknown MCP', 'Pick an MCP card on /setup.'));
    const now = Date.now();
    for (const [key, value] of googleStates) if (value.expiresAt < now) googleStates.delete(key);
    const state = randomToken(24);
    const { codeVerifier, codeChallenge } = await new OAuth2Client().generateCodeVerifierAsync();
    googleStates.set(sha256(state), {
      connectionId: connection.id,
      codeVerifier,
      sessionId: getSession(req)!.id,
      expiresAt: now + 10 * 60 * 1000,
    });
    res.redirect(303, connection.buildConsentUrl(googleRedirectUri, state, codeChallenge!));
  });

  server.get('/oauth/google/callback', async (req, res) => {
    const key = sha256(String(req.query.state ?? ''));
    const pending = googleStates.get(key);
    googleStates.delete(key);
    const fail = (message: string) =>
      html(res, 400, messagePage('Google connection failed', message));
    if (!pending || pending.expiresAt < Date.now()) {
      return fail('The request expired, was already used, or was not started from /setup.');
    }
    // The flow must finish in the same signed-in /setup session that started it.
    if (getSession(req)?.id !== pending.sessionId) {
      return fail(
        'Finish the Google sign-in in the same browser session that started it on /setup.',
      );
    }
    if (req.query.error) return fail(`Google returned: ${String(req.query.error)}`);
    const connection = app.google.get(pending.connectionId);
    try {
      await connection.completeConsent(
        String(req.query.code ?? ''),
        googleRedirectUri,
        pending.codeVerifier,
      );
      res.redirect(303, `/setup?connected=1&connection=${encodeURIComponent(connection.id)}`);
    } catch (error) {
      fail((error as Error).message);
    }
  });

  server.post('/setup/google/disconnect', form, requireSession, (req, res) => {
    const connection = formConnection(req);
    if (!connection)
      return html(res, 400, messagePage('Unknown MCP', 'Pick an MCP card on /setup.'));
    connection.disconnect();
    res.redirect(303, `/setup?disconnected=1&connection=${encodeURIComponent(connection.id)}`);
  });

  server.post('/setup/clients/revoke', form, requireSession, (req, res) => {
    provider.revokeClient(String(req.body.client_id ?? ''));
    res.redirect(303, '/setup?revoked=1');
  });

  return server;
}

export async function startHttp(app: AppContext): Promise<void> {
  const server = createHttpApp(app);
  await new Promise<void>((resolve) => {
    server.listen(app.config.port, app.config.host, () => resolve());
  });
  console.error(
    `[gsa-mcp] HTTP server listening on ${app.config.host}:${app.config.port} (${app.config.accessMode})`,
  );
  for (const c of enabledConnectors(app.config)) {
    const status = app.google.get(c.id).status();
    const google =
      status.mode === 'api_key'
        ? status.connected
          ? 'API key configured'
          : 'API key MISSING'
        : !status.connected
          ? 'Google NOT connected'
          : `Google: ${status.identity ?? 'connected'}${status.migratedFromShared ? ' (shared, from before upgrade)' : ''}${status.tokenRejectedAt ? ' — token REJECTED by Google, reconnect' : status.missingScopes.length ? ' — missing scopes, reconnect' : ''}`;
    console.error(
      `[gsa-mcp]   ${c.title} MCP: ${connectorUrl(c, app.config.publicUrl!).href} — ${google}`,
    );
  }
  if (app.google.all().some((c) => c.mode !== 'api_key' && !c.status().connected)) {
    console.error(
      `[gsa-mcp] Connect Google accounts at ${new URL('/setup', app.config.publicUrl).href}`,
    );
  }
}
