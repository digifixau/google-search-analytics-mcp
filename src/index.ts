#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { createAppContext } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { runGoogleAuthCli } from './google-auth-cli.js';
import { startHttp } from './http/app.js';
import { startStdio } from './stdio.js';

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const command = process.argv
    .slice(2)
    .find((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--connector');
  const config = loadConfig();
  const app = createAppContext(config);

  if (command === 'google-auth') {
    await runGoogleAuthCli(app);
    process.exit(0);
  }
  if (command && command !== 'serve') {
    throw new ConfigError(`Unknown command "${command}". Use "serve" (default) or "google-auth".`);
  }
  if (config.transport === 'http') await startHttp(app);
  else await startStdio(app, connectorArg() ?? process.env.MCP_CONNECTOR ?? 'search-analytics');
}

/** `--connector gtm` or `--connector=gtm` */
function connectorArg(): string | undefined {
  const args = process.argv.slice(2);
  const i = args.findIndex((a) => a === '--connector' || a.startsWith('--connector='));
  if (i === -1) return undefined;
  return args[i]!.includes('=') ? args[i]!.split('=')[1] : args[i + 1];
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? `Configuration error: ${error.message}` : error);
  process.exit(1);
});
