import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MCP_SCOPES, type Config } from '../config.js';
import type { GoogleApisProvider } from '../google/clients.js';
import type { AuditLog } from '../store/db.js';
import { allTools } from '../tools/index.js';
import { isToolEnabled, type ToolContext, type ToolDef } from '../tools/registry.js';
import { describeError } from '../util/errors.js';
import type { AccessPolicy } from '../util/policy.js';

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

function instructions(config: Config, canWrite: boolean): string {
  const lines = [
    'Google Search Console (GSC) and Google Analytics 4 (GA4) data for the owner of this server.',
    'Start with gsc_list_sites or ga4_list_properties to discover the exact siteUrl / propertyId values.',
    'GSC siteUrl is either a URL-prefix property ("https://example.com/") or a domain property ("sc-domain:example.com").',
    'GSC data lags ~2-3 days; GA4 supports relative dates like "28daysAgo", "yesterday", "today".',
    'For GA4, call ga4_get_metadata to find valid dimension/metric API names (including custom definitions).',
  ];
  if (canWrite) {
    lines.push(
      'This connection has WRITE access. Write tools change live Google configuration: confirm the exact change with the user before calling them.',
    );
  } else {
    lines.push(
      config.accessMode === 'readonly'
        ? 'The server runs in READ-ONLY mode: no changes can be made.'
        : 'This connection was granted read-only access: no changes can be made.',
    );
  }
  return lines.join('\n');
}

/** Builds an MCP server exposing only the tools this grant may use. */
export function buildMcpServer(deps: ServerDeps, grant: Grant): McpServer {
  const { config } = deps;
  const tools = (deps.tools ?? allTools).filter((t) => isToolEnabled(t, config, grant.scopes));
  const canWrite = tools.some((t) => t.access === 'write');

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: instructions(config, canWrite), capabilities: { tools: {} } },
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
