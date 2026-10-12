import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MCP_SCOPES, type Config } from '../config.js';
import type { GoogleApisProvider } from '../google/clients.js';
import type { AuditLog } from '../store/db.js';
import { allTools } from '../tools/index.js';
import { isToolEnabled, serviceOf, type ToolContext, type ToolDef } from '../tools/registry.js';
import { describeError } from '../util/errors.js';
import type { AccessPolicy } from '../util/policy.js';
import { CONNECTORS, connectorInstructions, type ConnectorDef } from './connectors.js';

export const SERVER_NAME = 'google-search-analytics-mcp';
export const SERVER_VERSION = '0.1.0';

export interface ServerDeps {
  config: Config;
  apis: GoogleApisProvider;
  policy: AccessPolicy;
  audit: AuditLog;
  tools?: ToolDef[];
}

export interface Grant {
  scopes: readonly string[];
  actor: string;
}

/** True if the tool belongs to this connector (by service, or the shared search/fetch tools). */
export function toolInConnector(def: ToolDef, connector: ConnectorDef): boolean {
  const service = serviceOf(def.toolset);
  return service ? connector.services.includes(service) : connector.includeCompat;
}

/** Builds an MCP server for one connector, exposing only the tools this grant may use. */
export function buildMcpServer(
  deps: ServerDeps,
  grant: Grant,
  connector: ConnectorDef = CONNECTORS[0]!,
): McpServer {
  const { config } = deps;
  const tools = (deps.tools ?? allTools).filter(
    (t) => toolInConnector(t, connector) && isToolEnabled(t, config, grant.scopes),
  );
  const canWrite = tools.some((t) => t.access === 'write');

  const server = new McpServer(
    { name: connector.serverName, version: SERVER_VERSION },
    {
      instructions: connectorInstructions(connector, config, canWrite),
      capabilities: { tools: {} },
    },
  );

  const ctx: ToolContext = { apis: deps.apis, policy: deps.policy, config, actor: grant.actor };

  for (const def of tools) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.access === 'write' ? `[WRITE] ${def.description}` : def.description,
        inputSchema: def.inputSchema,
        annotations: {
          title: def.title,
          readOnlyHint: def.access === 'read',
          destructiveHint: def.access === 'write' ? Boolean(def.destructive) : false,
          idempotentHint: def.idempotent ?? def.access === 'read',
          openWorldHint: true,
        },
      },
      async (args: unknown): Promise<CallToolResult> => {
        try {
          const result = await def.handler(args as never, ctx);
          if (def.access === 'write') {
            deps.audit.record({ actor: grant.actor, tool: def.name, args, outcome: 'ok' });
          }
          return result;
        } catch (error) {
          const message = describeError(error);
          if (def.access === 'write') {
            deps.audit.record({
              actor: grant.actor,
              tool: def.name,
              args,
              outcome: 'error',
              detail: message,
            });
          }
          return { isError: true, content: [{ type: 'text', text: message }] };
        }
      },
    );
  }

  if (tools.length === 0) {
    // McpServer only installs tool handlers once a tool is registered; answer tools/list with an empty list instead of "method not found".
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
  }

  return server;
}

export function scopesForAccessMode(config: Config): string[] {
  return config.accessMode === 'readwrite'
    ? [MCP_SCOPES.read, MCP_SCOPES.write]
    : [MCP_SCOPES.read];
}
