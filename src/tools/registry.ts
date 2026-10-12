import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { MCP_SCOPES, type Config, type Service, type WriteToolset } from '../config.js';
import type { GoogleApisProvider } from '../google/clients.js';
import type { AccessPolicy } from '../util/policy.js';

export type Toolset = 'gsc' | 'ga4' | 'compat' | WriteToolset;

/** Which Google product a toolset belongs to (used by ENABLED_SERVICES). `compat` spans all of them. */
export function serviceOf(toolset: Toolset): Service | undefined {
  if (toolset === 'gsc' || toolset === 'indexing') return 'gsc';
  if (toolset === 'ga4' || toolset === 'ga4_admin' || toolset === 'ga4_audiences_streams')
    return 'ga4';
  if (toolset === 'gtm' || toolset === 'gtm_publish') return 'gtm';
  return undefined;
}

export interface ToolContext {
  apis: GoogleApisProvider;
  policy: AccessPolicy;
  config: Config;
  /** Who is calling (OAuth client id, API key label or "stdio"); used for the audit log. */
  actor: string;
}

export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  access: 'read' | 'write';
  toolset: Toolset;
  /** Write tools only: the change deletes/archives something. */
  destructive?: boolean;
  idempotent?: boolean;
  inputSchema: Shape;
  handler: (args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext) => Promise<CallToolResult>;
}

export function defineTool<Shape extends z.ZodRawShape>(def: ToolDef<Shape>): ToolDef<Shape> {
  return def;
}

/**
 * Central access rule. A tool is exposed only if every layer allows it:
 *  1. server ACCESS_MODE (readonly hides all write tools),
 *  2. the caller's token scopes (mcp:write needed for write tools),
 *  3. WRITE_TOOLSETS (which write families are enabled at all).
 * Indexing API reads also need the `indexing` Google scope, which is only requested in read-write mode.
 */
export function isToolEnabled(def: ToolDef, config: Config, scopes: readonly string[]): boolean {
  if (!scopes.includes(MCP_SCOPES.read)) return false;
  const service = serviceOf(def.toolset);
  if (service && !config.enabledServices.includes(service)) return false;
  const writeEnabled = config.accessMode === 'readwrite';
  const toolsetEnabled = (config.writeToolsets as string[]).includes(def.toolset);
  if (def.access === 'write') {
    return writeEnabled && scopes.includes(MCP_SCOPES.write) && toolsetEnabled;
  }
  if (def.toolset === 'indexing') return writeEnabled && toolsetEnabled;
  return true;
}
