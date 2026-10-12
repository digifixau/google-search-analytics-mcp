import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AppContext } from './app.js';
import { buildMcpServer, scopesForAccessMode } from './mcp/server.js';

export async function startStdio(app: AppContext): Promise<void> {
  const server = buildMcpServer(app, { scopes: scopesForAccessMode(app.config), actor: 'stdio' });
  await server.connect(new StdioServerTransport());
  const status = app.googleAuth.status();
  console.error(
    `[gsa-mcp] stdio server ready (${app.config.accessMode}); Google ${status.connected ? `connected as ${status.identity}` : 'NOT connected — run `google-auth`'}`,
  );
}
