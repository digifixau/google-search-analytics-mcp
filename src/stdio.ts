import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AppContext } from './app.js';
import { ConfigError } from './config.js';
import { CONNECTORS, enabledConnectors } from './mcp/connectors.js';
import { buildMcpServer, scopesForAccessMode } from './mcp/server.js';

/** Runs one connector over stdio (`--connector gtm` or MCP_CONNECTOR=gtm; default: search-analytics). */
export async function startStdio(app: AppContext, connectorId = 'search-analytics'): Promise<void> {
  const connector = enabledConnectors(app.config).find((c) => c.id === connectorId);
  if (!connector) {
    throw new ConfigError(
      `MCP connector "${connectorId}" is unknown or disabled by ENABLED_SERVICES. Available: ${CONNECTORS.map((c) => c.id).join(', ')}`,
    );
  }
  const server = buildMcpServer(
    app,
    { scopes: scopesForAccessMode(app.config), actor: 'stdio' },
    connector,
  );
  await server.connect(new StdioServerTransport());
  const status = app.google.get(connector.id).status();
  const google =
    status.mode === 'api_key'
      ? status.connected
        ? 'API key configured'
        : 'API key MISSING (set GOOGLE_PLACES_API_KEY)'
      : status.connected
        ? `Google connected as ${status.identity}`
        : `Google NOT connected — run \`google-auth --connector ${connector.id}\``;
  console.error(
    `[gsa-mcp] stdio ${connector.title} MCP ready (${app.config.accessMode}); ${google}`,
  );
}
