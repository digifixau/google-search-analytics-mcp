import type { Config } from './config.js';
import { GoogleConnections } from './google/auth.js';
import {
  createGoogleApisProvider,
  createPlacesApisProvider,
  type GoogleApisProvider,
} from './google/clients.js';
import { Encryptor } from './store/crypto.js';
import { AuditLog, KvStore, openDb, type Db } from './store/db.js';
import { AccessPolicy } from './util/policy.js';

export interface AppContext {
  config: Config;
  db: Db;
  kv: KvStore;
  encryptor?: Encryptor;
  /** One independent Google connection per MCP. */
  google: GoogleConnections;
  /** Google API clients authenticated with one MCP's own connection. */
  apisFor: (connectionId: string) => GoogleApisProvider;
  policy: AccessPolicy;
  audit: AuditLog;
  /** Flags one MCP's connection when Google refuses its saved sign-in (shown on /setup). */
  onGoogleTokenRejected: (connectionId: string) => void;
}

export function createAppContext(config: Config): AppContext {
  const db = openDb(config.dataDir);
  const kv = new KvStore(db);
  const encryptor = config.encryptionKey ? new Encryptor(config.encryptionKey) : undefined;
  const google = new GoogleConnections(config, kv, encryptor);
  google.migrateShared();
  const providers = new Map<string, GoogleApisProvider>();
  return {
    config,
    db,
    kv,
    encryptor,
    google,
    apisFor: (connectionId) => {
      let provider = providers.get(connectionId);
      if (!provider) {
        const connection = google.get(connectionId);
        provider =
          connection.mode === 'api_key'
            ? createPlacesApisProvider(() => config.google.placesApiKey)
            : createGoogleApisProvider(() => connection.getClient());
        providers.set(connectionId, provider);
      }
      return provider;
    },
    policy: new AccessPolicy(config),
    audit: new AuditLog(db),
    onGoogleTokenRejected: (connectionId) => {
      if (google.has(connectionId)) google.get(connectionId).markTokenRejected();
    },
  };
}
