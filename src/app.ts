import type { Config } from './config.js';
import { GoogleAuthManager } from './google/auth.js';
import { createGoogleApisProvider, type GoogleApisProvider } from './google/clients.js';
import { Encryptor } from './store/crypto.js';
import { AuditLog, KvStore, openDb, type Db } from './store/db.js';
import { AccessPolicy } from './util/policy.js';

export interface AppContext {
  config: Config;
  db: Db;
  kv: KvStore;
  encryptor?: Encryptor;
  googleAuth: GoogleAuthManager;
  apis: GoogleApisProvider;
  policy: AccessPolicy;
  audit: AuditLog;
}

export function createAppContext(config: Config): AppContext {
  const db = openDb(config.dataDir);
  const kv = new KvStore(db);
  const encryptor = config.encryptionKey ? new Encryptor(config.encryptionKey) : undefined;
  const googleAuth = new GoogleAuthManager(config, kv, encryptor);
  return {
    config,
    db,
    kv,
    encryptor,
    googleAuth,
    apis: createGoogleApisProvider(() => googleAuth.getClient()),
    policy: new AccessPolicy(config),
    audit: new AuditLog(db),
  };
}
