import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig, type Config } from '../src/config.js';
import type { GoogleApis } from '../src/google/clients.js';
import { getConnector } from '../src/mcp/connectors.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { AuditLog, openDb } from '../src/store/db.js';
import { AccessPolicy } from '../src/util/policy.js';

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    GOOGLE_AUTH_MODE: 'oauth',
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'secret',
    ENCRYPTION_KEY: 'x'.repeat(32),
    DATA_DIR: ':memory:',
    ...env,
  });
}

export async function connectClient(
  config: Config,
  scopes: string[],
  apis: Partial<GoogleApis> = {},
  connectorId = 'search-analytics',
) {
  const db = openDb(':memory:');
  const audit = new AuditLog(db);
  const server = buildMcpServer(
    {
      config,
      apisFor: () => async () => apis as GoogleApis,
      policy: new AccessPolicy(config),
      audit,
    },
    { scopes, actor: 'test' },
    getConnector(connectorId),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, audit, db };
}

export function text(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]?.text ?? '';
}
