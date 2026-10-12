import { describe, expect, it } from 'vitest';
import { AccessPolicy, normalizeSite, urlBelongsToSite } from '../src/util/policy.js';
import { previousPeriod, resolveDate } from '../src/util/dates.js';
import { Encryptor } from '../src/store/crypto.js';
import { testConfig } from './helpers.js';

describe('policy', () => {
  it('normalises sites', () => {
    expect(normalizeSite('https://Example.com')).toBe('https://example.com/');
    expect(normalizeSite('sc-domain:Example.com')).toBe('sc-domain:example.com');
  });

  it('matches URLs to properties', () => {
    expect(urlBelongsToSite('https://blog.example.com/a', 'sc-domain:example.com')).toBe(true);
    expect(urlBelongsToSite('https://notexample.com/a', 'sc-domain:example.com')).toBe(false);
    expect(urlBelongsToSite('https://example.com/shop/x', 'https://example.com/shop/')).toBe(true);
    expect(urlBelongsToSite('https://example.com/blog', 'https://example.com/shop/')).toBe(false);
  });

  it('enforces read and write allowlists', () => {
    const p = new AccessPolicy(
      testConfig({
        ALLOWED_GSC_SITES: 'sc-domain:a.com,https://b.com/',
        WRITE_ALLOWED_GSC_SITES: 'sc-domain:a.com',
        ALLOWED_GA4_PROPERTIES: 'properties/1,2',
        WRITE_ALLOWED_GA4_PROPERTIES: '2',
      }),
    );
    expect(p.siteAllowed('https://b.com')).toBe(true);
    expect(p.siteAllowed('https://b.com', 'write')).toBe(false);
    expect(p.siteAllowed('sc-domain:A.com', 'write')).toBe(true);
    expect(p.siteAllowed('https://c.com')).toBe(false);
    expect(p.assertProperty('properties/1')).toBe('1');
    expect(() => p.assertProperty('1', 'write')).toThrow(/write allowlist/);
    expect(() => p.assertProperty('3')).toThrow(/allowlist/);
    expect(() => p.assertProperty('abc')).toThrow(/not a GA4 property/);
    expect(() => p.assertResourceName('properties/1/customDimensions/9', 'write')).toThrow();
    expect(p.assertResourceName('properties/2/customDimensions/9', 'write')).toBe(
      'properties/2/customDimensions/9',
    );
    expect(() => p.assertUrl('https://evil.com/x')).toThrow();
    expect(() => p.assertUrl('https://www.a.com/x', 'write')).not.toThrow();
  });

  it('allows everything when no allowlists are set', () => {
    const p = new AccessPolicy(testConfig());
    expect(p.siteAllowed('https://anything.com/', 'write')).toBe(true);
    expect(p.propertyAllowed('42', 'write')).toBe(true);
  });
});

describe('dates', () => {
  const now = new Date('2026-03-10T12:00:00Z');
  it('resolves relative dates', () => {
    expect(resolveDate('today', now)).toBe('2026-03-10');
    expect(resolveDate('yesterday', now)).toBe('2026-03-09');
    expect(resolveDate('28daysAgo', now)).toBe('2026-02-10');
    expect(resolveDate('2025-01-01', now)).toBe('2025-01-01');
    expect(() => resolveDate('last week', now)).toThrow();
  });
  it('computes the previous period', () => {
    expect(previousPeriod('2026-02-01', '2026-02-28')).toEqual({
      startDate: '2026-01-04',
      endDate: '2026-01-31',
    });
  });
});

describe('encryptor', () => {
  it('round-trips and rejects tampering', () => {
    const e = new Encryptor('k'.repeat(32));
    const c = e.encrypt('refresh-token');
    expect(c).not.toContain('refresh-token');
    expect(e.decrypt(c)).toBe('refresh-token');
    expect(() => new Encryptor('z'.repeat(32)).decrypt(c)).toThrow();
  });
});
