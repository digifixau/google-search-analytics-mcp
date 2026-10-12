import type { KvStore } from '../store/db.js';

const KV_KEY = 'security.login_failures';
const WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_IPS = 1000;

interface Counter {
  count: number;
  resetAt: number;
}

interface State {
  global: Counter;
  ips: Record<string, Counter>;
}

export interface LoginGuardOptions {
  perIpLimit?: number;
  globalLimit?: number;
}

/**
 * Brute-force protection for the admin password, shared by the consent page and /setup.
 * Per-IP limit stops a single source; the global limit stops attackers rotating IPs.
 * Counters live in SQLite so a restart does not reset them.
 */
export class LoginGuard {
  private readonly perIpLimit: number;
  private readonly globalLimit: number;

  constructor(
    private readonly kv: KvStore,
    options: LoginGuardOptions = {},
  ) {
    this.perIpLimit = options.perIpLimit ?? 10;
    this.globalLimit = options.globalLimit ?? 30;
  }

  /** True if a password attempt from this IP may be evaluated right now. */
  allowed(ip: string): boolean {
    const now = Date.now();
    const state = this.load(now);
    if (state.global.resetAt > now && state.global.count >= this.globalLimit) return false;
    const entry = state.ips[ip];
    return !entry || entry.resetAt <= now || entry.count < this.perIpLimit;
  }

  recordFailure(ip: string): void {
    const now = Date.now();
    const state = this.load(now);
    state.global = bump(state.global, now);
    state.ips[ip] = bump(state.ips[ip], now);

    if (state.global.count === this.globalLimit) {
      console.error(
        `[security] ${this.globalLimit} failed admin password attempts in 15 minutes; all password logins locked until ${new Date(state.global.resetAt).toISOString()}`,
      );
    }
    if (state.ips[ip]!.count === this.perIpLimit) {
      console.error(
        `[security] ${this.perIpLimit} failed admin password attempts from ${ip}; IP locked for 15 minutes`,
      );
    }

    const ips = Object.entries(state.ips);
    if (ips.length > MAX_TRACKED_IPS) {
      ips.sort((a, b) => b[1].resetAt - a[1].resetAt);
      state.ips = Object.fromEntries(ips.slice(0, MAX_TRACKED_IPS));
    }
    this.kv.set(KV_KEY, JSON.stringify(state));
  }

  private load(now: number): State {
    let state: State = { global: { count: 0, resetAt: 0 }, ips: {} };
    const raw = this.kv.get(KV_KEY);
    if (raw) {
      try {
        state = JSON.parse(raw) as State;
      } catch {
        // Corrupt state: start fresh rather than locking the owner out forever.
      }
    }
    for (const [ip, counter] of Object.entries(state.ips)) {
      if (counter.resetAt <= now) delete state.ips[ip];
    }
    return state;
  }
}

function bump(counter: Counter | undefined, now: number): Counter {
  if (!counter || counter.resetAt <= now) return { count: 1, resetAt: now + WINDOW_MS };
  return { count: counter.count + 1, resetAt: counter.resetAt };
}
