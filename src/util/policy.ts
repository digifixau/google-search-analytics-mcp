import { normalizePropertyId, type Config } from '../config.js';
import { AccessDeniedError } from './errors.js';

/** Normalises a Search Console property for comparison (`sc-domain:` and URL-prefix properties). */
export function normalizeSite(site: string): string {
  const s = site.trim();
  if (s.toLowerCase().startsWith('sc-domain:')) return `sc-domain:${s.slice(10).toLowerCase()}`;
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`}`;
  } catch {
    return s.toLowerCase();
  }
}

/** True if `url` belongs to the Search Console property `site`. */
export function urlBelongsToSite(url: string, site: string): boolean {
  const normalized = normalizeSite(site);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (normalized.startsWith('sc-domain:')) {
    const domain = normalized.slice(10);
    const host = parsed.hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  }
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname}`.startsWith(
    normalized,
  );
}

/** Enforces the optional ALLOWED_* / WRITE_ALLOWED_* allowlists. Empty list = everything allowed. */
export class AccessPolicy {
  constructor(private readonly config: Config) {}

  private gscList(mode: 'read' | 'write'): string[] {
    const list =
      mode === 'write' && this.config.allowlists.writeGscSites.length > 0
        ? this.config.allowlists.writeGscSites
        : this.config.allowlists.gscSites;
    return list.map(normalizeSite);
  }

  private ga4List(mode: 'read' | 'write'): string[] {
    return mode === 'write' && this.config.allowlists.writeGa4Properties.length > 0
      ? this.config.allowlists.writeGa4Properties
      : this.config.allowlists.ga4Properties;
  }

  siteAllowed(site: string, mode: 'read' | 'write' = 'read'): boolean {
    const list = this.gscList(mode);
    if (mode === 'write' && list.length > 0 && !this.siteAllowed(site, 'read')) return false;
    return list.length === 0 || list.includes(normalizeSite(site));
  }

  assertSite(site: string, mode: 'read' | 'write' = 'read'): void {
    if (!this.siteAllowed(site, mode)) {
      throw new AccessDeniedError(
        `Search Console property "${site}" is not in the ${mode === 'write' ? 'write ' : ''}allowlist.`,
      );
    }
  }

  /** For URL-level operations (inspection, Indexing API): the URL must sit inside an allowed property. */
  assertUrl(url: string, mode: 'read' | 'write' = 'read'): void {
    const list = this.gscList(mode);
    if (list.length === 0) return;
    if (!list.some((site) => urlBelongsToSite(url, site))) {
      throw new AccessDeniedError(`URL "${url}" is not inside an allowed Search Console property.`);
    }
  }

  propertyAllowed(property: string, mode: 'read' | 'write' = 'read'): boolean {
    const id = normalizePropertyId(property);
    const readList = this.ga4List('read');
    if (readList.length > 0 && !readList.includes(id)) return false;
    const list = this.ga4List(mode);
    return list.length === 0 || list.includes(id);
  }

  assertProperty(property: string, mode: 'read' | 'write' = 'read'): string {
    const id = normalizePropertyId(property);
    if (!/^\d+$/.test(id)) {
      throw new AccessDeniedError(
        `"${property}" is not a GA4 property ID (expected digits, e.g. 123456789).`,
      );
    }
    if (!this.propertyAllowed(id, mode)) {
      throw new AccessDeniedError(
        `GA4 property ${id} is not in the ${mode === 'write' ? 'write ' : ''}allowlist.`,
      );
    }
    return id;
  }

  /**
   * GTM container allowlist. Entries may be public IDs (GTM-XXXX) or numeric container IDs;
   * the caller passes both so either form matches.
   */
  containerAllowed(
    containerId: string,
    publicId: string | undefined,
    mode: 'read' | 'write' = 'read',
  ): boolean {
    const matches = (list: string[]) =>
      list.length === 0 ||
      list.includes(containerId) ||
      (!!publicId && list.includes(publicId.toUpperCase()));
    const { gtmContainers, writeGtmContainers } = this.config.allowlists;
    if (!matches(gtmContainers)) return false;
    return mode === 'read' || matches(writeGtmContainers);
  }

  get hasContainerAllowlist(): boolean {
    const { gtmContainers, writeGtmContainers } = this.config.allowlists;
    return gtmContainers.length > 0 || writeGtmContainers.length > 0;
  }

  /** Extracts and checks the property from a resource name like `properties/123/customDimensions/456`. */
  assertResourceName(name: string, mode: 'read' | 'write' = 'read'): string {
    const match = /^properties\/(\d+)\//.exec(name);
    if (!match)
      throw new AccessDeniedError(`"${name}" is not a GA4 resource name under properties/{id}/...`);
    this.assertProperty(match[1]!, mode);
    return name;
  }
}
