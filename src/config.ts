import { z } from 'zod';

export const WRITE_TOOLSETS = ['gsc', 'indexing', 'ga4_admin', 'ga4_audiences_streams'] as const;
export type WriteToolset = (typeof WRITE_TOOLSETS)[number];

const csv = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return fallback;
      return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
    });

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value && value.trim() !== '' ? value.trim() : undefined));

const envSchema = z.object({
  TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  ACCESS_MODE: z.enum(['readonly', 'readwrite']).default('readonly'),
  WRITE_TOOLSETS: csv,

  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: optionalString,
  DATA_DIR: z.string().default('./data'),
  TRUST_PROXY: bool(true),

  ADMIN_PASSWORD: optionalString,
  ENCRYPTION_KEY: optionalString,
  MCP_API_KEYS: optionalString,
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  GOOGLE_AUTH_MODE: z.enum(['oauth', 'service_account']).default('oauth'),
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_OWNER_EMAIL: optionalString,
  GOOGLE_SERVICE_ACCOUNT_JSON: optionalString,

  ALLOWED_GSC_SITES: csv,
  ALLOWED_GA4_PROPERTIES: csv,
  WRITE_ALLOWED_GSC_SITES: csv,
  WRITE_ALLOWED_GA4_PROPERTIES: csv,

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type AccessMode = 'readonly' | 'readwrite';

export interface ApiKey {
  key: string;
  label: string;
  scopes: string[];
}

export interface Config {
  transport: 'stdio' | 'http';
  accessMode: AccessMode;
  writeToolsets: WriteToolset[];
  host: string;
  port: number;
  publicUrl?: URL;
  dataDir: string;
  trustProxy: boolean;
  adminPassword?: string;
  encryptionKey?: string;
  apiKeys: ApiKey[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  google: {
    authMode: 'oauth' | 'service_account';
    clientId?: string;
    clientSecret?: string;
    ownerEmail?: string;
    serviceAccountJson?: string;
  };
  allowlists: {
    gscSites: string[];
    ga4Properties: string[];
    writeGscSites: string[];
    writeGa4Properties: string[];
  };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export class ConfigError extends Error {}

export const MCP_SCOPES = { read: 'mcp:read', write: 'mcp:write' } as const;

/**
 * Parses `MCP_API_KEYS`, a comma separated list of `key:scope[+scope]` or
 * `label=key:scope[+scope]` entries, e.g. `claude-code=s3cret:read+write,n8n=other:read`.
 */
export function parseApiKeys(raw: string | undefined): ApiKey[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const eq = entry.indexOf('=');
      const label = eq > 0 ? entry.slice(0, eq) : `api-key-${index + 1}`;
      const rest = eq > 0 ? entry.slice(eq + 1) : entry;
      const colon = rest.lastIndexOf(':');
      const key = colon > 0 ? rest.slice(0, colon) : rest;
      const scopeSpec = colon > 0 ? rest.slice(colon + 1) : 'read';
      const scopes = scopeSpec
        .split('+')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .map((s) => {
          if (s !== 'read' && s !== 'write') {
            throw new ConfigError(`MCP_API_KEYS entry "${label}" has unknown scope "${s}"`);
          }
          return s === 'read' ? MCP_SCOPES.read : MCP_SCOPES.write;
        });
      if (key.length < 24) {
        throw new ConfigError(`MCP_API_KEYS entry "${label}" must be at least 24 characters long`);
      }
      if (!scopes.includes(MCP_SCOPES.read)) scopes.unshift(MCP_SCOPES.read);
      return { key, label, scopes };
    });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${details}`);
  }
  const e = parsed.data;

  const unknownToolsets = e.WRITE_TOOLSETS.filter(
    (t) => !(WRITE_TOOLSETS as readonly string[]).includes(t),
  );
  if (unknownToolsets.length > 0) {
    throw new ConfigError(
      `WRITE_TOOLSETS contains unknown values: ${unknownToolsets.join(', ')}. Valid: ${WRITE_TOOLSETS.join(', ')}`,
    );
  }

  let publicUrl: URL | undefined;
  if (e.PUBLIC_URL) {
    try {
      publicUrl = new URL(e.PUBLIC_URL.replace(/\/+$/, ''));
    } catch {
      throw new ConfigError('PUBLIC_URL must be an absolute URL, e.g. https://mcp.example.com');
    }
  }

  const config: Config = {
    transport: e.TRANSPORT,
    accessMode: e.ACCESS_MODE,
    writeToolsets:
      e.WRITE_TOOLSETS.length > 0 ? (e.WRITE_TOOLSETS as WriteToolset[]) : [...WRITE_TOOLSETS],
    host: e.HOST,
    port: e.PORT,
    publicUrl,
    dataDir: e.DATA_DIR,
    trustProxy: e.TRUST_PROXY,
    adminPassword: e.ADMIN_PASSWORD,
    encryptionKey: e.ENCRYPTION_KEY,
    apiKeys: parseApiKeys(e.MCP_API_KEYS),
    accessTokenTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: e.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
    google: {
      authMode: e.GOOGLE_AUTH_MODE,
      clientId: e.GOOGLE_CLIENT_ID,
      clientSecret: e.GOOGLE_CLIENT_SECRET,
      ownerEmail: e.GOOGLE_OWNER_EMAIL?.toLowerCase(),
      serviceAccountJson: e.GOOGLE_SERVICE_ACCOUNT_JSON,
    },
    allowlists: {
      gscSites: e.ALLOWED_GSC_SITES,
      ga4Properties: e.ALLOWED_GA4_PROPERTIES.map(normalizePropertyId),
      writeGscSites: e.WRITE_ALLOWED_GSC_SITES,
      writeGa4Properties: e.WRITE_ALLOWED_GA4_PROPERTIES.map(normalizePropertyId),
    },
    logLevel: e.LOG_LEVEL,
  };

  validateConfig(config);
  return config;
}

function validateConfig(config: Config): void {
  if (config.google.authMode === 'oauth') {
    if (!config.google.clientId || !config.google.clientSecret) {
      throw new ConfigError(
        'GOOGLE_AUTH_MODE=oauth requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET',
      );
    }
    if (!config.encryptionKey) {
      throw new ConfigError(
        'ENCRYPTION_KEY is required in oauth mode (it encrypts the stored Google refresh token)',
      );
    }
  } else if (!config.google.serviceAccountJson) {
    throw new ConfigError('GOOGLE_AUTH_MODE=service_account requires GOOGLE_SERVICE_ACCOUNT_JSON');
  }

  if (config.encryptionKey && config.encryptionKey.length < 32) {
    throw new ConfigError(
      'ENCRYPTION_KEY must be at least 32 characters (use `openssl rand -hex 32`)',
    );
  }

  if (config.transport === 'http') {
    if (!config.publicUrl) {
      throw new ConfigError(
        'TRANSPORT=http requires PUBLIC_URL (the externally reachable base URL)',
      );
    }
    if (!config.adminPassword || config.adminPassword.length < 16) {
      throw new ConfigError(
        'TRANSPORT=http requires ADMIN_PASSWORD with at least 16 characters (used to approve connections; generate one with `openssl rand -base64 24`)',
      );
    }
    if (config.google.authMode === 'oauth' && !config.google.ownerEmail) {
      throw new ConfigError(
        'TRANSPORT=http with GOOGLE_AUTH_MODE=oauth requires GOOGLE_OWNER_EMAIL, so only your Google account can ever be connected',
      );
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(config.publicUrl.hostname);
    if (config.publicUrl.protocol !== 'https:' && !local) {
      throw new ConfigError('PUBLIC_URL must use https:// (only localhost may use http://)');
    }
  }
}

/** Accepts `123456`, `properties/123456` and returns `123456`. */
export function normalizePropertyId(value: string): string {
  return value.trim().replace(/^properties\//, '');
}
