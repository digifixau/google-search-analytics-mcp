import { createServer } from 'node:http';
import type { AppContext } from './app.js';
import { randomToken } from './store/crypto.js';

/**
 * One-time Google consent for local (stdio) use. Opens a loopback listener and prints the consent URL.
 * Add http://localhost:<port>/oauth/google/callback as an authorised redirect URI on your OAuth client.
 */
export async function runGoogleAuthCli(app: AppContext): Promise<void> {
  if (app.config.google.authMode !== 'oauth') {
    console.error('GOOGLE_AUTH_MODE is service_account — nothing to do.');
    return;
  }
  const port = Number(process.env.GOOGLE_AUTH_PORT ?? 53682);
  const redirectUri = `http://localhost:${port}/oauth/google/callback`;
  const state = randomToken(16);

  await new Promise<void>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', redirectUri);
      if (url.pathname !== '/oauth/google/callback') {
        res.writeHead(404).end();
        return;
      }
      const done = (status: number, message: string) => {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(message);
        server.close();
      };
      if (url.searchParams.get('state') !== state) {
        done(400, 'State mismatch. Start again.');
        reject(new Error('OAuth state mismatch'));
        return;
      }
      const error = url.searchParams.get('error');
      if (error) {
        done(400, `Google returned an error: ${error}`);
        reject(new Error(error));
        return;
      }
      try {
        const status = await app.googleAuth.completeConsent(
          url.searchParams.get('code') ?? '',
          redirectUri,
        );
        done(200, `Connected as ${status.identity ?? 'unknown'}. You can close this tab.`);
        console.error(
          `Connected Google account ${status.identity}. Granted scopes:\n  ${status.grantedScopes.join('\n  ')}`,
        );
        if (status.missingScopes.length)
          console.error(`WARNING: missing scopes:\n  ${status.missingScopes.join('\n  ')}`);
        resolve();
      } catch (err) {
        done(500, `Failed: ${(err as Error).message}`);
        reject(err);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      console.error(
        `Open this URL in your browser to connect Google (${app.config.accessMode} scopes):\n\n${app.googleAuth.buildConsentUrl(redirectUri, state)}\n`,
      );
      console.error(`Waiting for the redirect to ${redirectUri} ...`);
    });
  });
}
