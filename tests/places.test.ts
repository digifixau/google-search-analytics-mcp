import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoogleApis } from '../src/google/clients.js';
import { createPlacesApisProvider } from '../src/google/clients.js';
import { DETAIL_FIELDS, fieldMask } from '../src/tools/places.js';
import { describeError } from '../src/util/errors.js';
import { connectClient, testConfig, text } from './helpers.js';

const READ = ['mcp:read'];
const RW = ['mcp:read', 'mcp:write'];
const PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';

const apisWith = (places: unknown) => ({ places }) as unknown as GoogleApis;

const coldCo = {
  id: PLACE_ID,
  displayName: { text: 'Cold Co Refrigeration' },
  formattedAddress: '1 Chill St, Melbourne VIC',
  location: { latitude: -37.8, longitude: 144.9 },
  primaryType: 'electrician',
  businessStatus: 'OPERATIONAL',
  googleMapsUri: 'https://maps.google.com/?cid=1',
  rating: 4.8,
  userRatingCount: 212,
  priceLevel: 'PRICE_LEVEL_MODERATE',
  websiteUri: 'https://coldco.example',
  nationalPhoneNumber: '(03) 5555 0100',
};

describe('places connector', () => {
  it('serves five read-only tools, with no write tools even in read-write mode', async () => {
    for (const scopes of [READ, RW]) {
      const { client } = await connectClient(
        testConfig({ ACCESS_MODE: 'readwrite' }),
        scopes,
        {},
        'places',
      );
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual([
        'places_search_text',
        'places_search_nearby',
        'places_get_place',
        'places_get_reviews',
        'places_get_photo',
      ]);
    }
  });

  it('keeps the other MCPs free of Places tools', async () => {
    const { client } = await connectClient(testConfig({ ACCESS_MODE: 'readwrite' }), RW, {});
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.some((n) => n.startsWith('places_'))).toBe(false);
  });
});

describe('places field masks', () => {
  it('builds the mask from the detail preset', () => {
    expect(fieldMask('basic', 'places.')).toBe(
      DETAIL_FIELDS.basic.map((f) => `places.${f}`).join(','),
    );
    expect(fieldMask('standard', 'places.', ['nextPageToken'])).toContain('places.rating');
    expect(fieldMask('standard', 'places.', ['nextPageToken']).endsWith(',nextPageToken')).toBe(
      true,
    );
    expect(fieldMask('basic', '')).not.toContain('rating');
    expect(fieldMask('full', '')).toContain('photos');
    expect(fieldMask('full', '')).toContain('regularOpeningHours');
  });
});

describe('places tools', () => {
  it('searches by text with filters and a field mask, and renders a table', async () => {
    const searchText = vi
      .fn()
      .mockResolvedValue({ data: { places: [coldCo], nextPageToken: 'next-1' } });
    const { client } = await connectClient(
      testConfig(),
      READ,
      apisWith({ places: { searchText } }),
      'places',
    );
    const out = text(
      await client.callTool({
        name: 'places_search_text',
        arguments: {
          query: 'fridge repair Melbourne',
          minRating: 4.5,
          openNow: true,
          priceLevels: ['moderate'],
          nearLatitude: -37.81,
          nearLongitude: 144.96,
          nearRadiusMeters: 5000,
          maxResults: 5,
        },
      }),
    );
    const [params, options] = searchText.mock.calls[0]!;
    expect(params.requestBody).toMatchObject({
      textQuery: 'fridge repair Melbourne',
      minRating: 4.5,
      openNow: true,
      priceLevels: ['PRICE_LEVEL_MODERATE'],
      pageSize: 5,
      locationBias: { circle: { center: { latitude: -37.81, longitude: 144.96 }, radius: 5000 } },
    });
    expect(options.headers['X-Goog-FieldMask']).toBe(
      fieldMask('standard', 'places.', ['nextPageToken']),
    );
    expect(out).toContain(`| ${PLACE_ID} | Cold Co Refrigeration |`);
    expect(out).toContain('| 4.8 | 212 | moderate |');
    expect(out).toContain('pageToken "next-1"');
  });

  it('requires the three location fields together and caps results', async () => {
    const searchText = vi.fn().mockResolvedValue({ data: {} });
    const { client } = await connectClient(
      testConfig(),
      READ,
      apisWith({ places: { searchText } }),
      'places',
    );
    const partial = await client.callTool({
      name: 'places_search_text',
      arguments: { query: 'cafe', nearLatitude: -37.8 },
    });
    expect(partial.isError).toBe(true);
    expect(text(partial)).toContain('together');
    const tooMany = await client.callTool({
      name: 'places_search_text',
      arguments: { query: 'cafe', maxResults: 21 },
    });
    expect(tooMany.isError).toBe(true);
    expect(searchText).not.toHaveBeenCalled();
  });

  it('searches nearby with types, ranking and a bounded radius', async () => {
    const searchNearby = vi.fn().mockResolvedValue({ data: { places: [coldCo] } });
    const { client } = await connectClient(
      testConfig(),
      READ,
      apisWith({ places: { searchNearby } }),
      'places',
    );
    const out = text(
      await client.callTool({
        name: 'places_search_nearby',
        arguments: {
          latitude: -37.8,
          longitude: 144.9,
          radiusMeters: 2000,
          includedTypes: ['electrician'],
          rankBy: 'distance',
          detail: 'basic',
        },
      }),
    );
    const [params, options] = searchNearby.mock.calls[0]!;
    expect(params.requestBody).toMatchObject({
      locationRestriction: {
        circle: { center: { latitude: -37.8, longitude: 144.9 }, radius: 2000 },
      },
      includedTypes: ['electrician'],
      rankPreference: 'DISTANCE',
      maxResultCount: 10,
    });
    expect(options.headers['X-Goog-FieldMask']).toBe(fieldMask('basic', 'places.'));
    expect(out).toContain('Cold Co Refrigeration');
    expect(out).not.toContain('4.8');

    const far = await client.callTool({
      name: 'places_search_nearby',
      arguments: { latitude: -37.8, longitude: 144.9, radiusMeters: 50_001 },
    });
    expect(far.isError).toBe(true);
    expect(searchNearby).toHaveBeenCalledTimes(1);
  });

  it('gets one place, accepting a "places/" prefix, with photo references', async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        ...coldCo,
        regularOpeningHours: { weekdayDescriptions: ['Monday: 8:00 AM – 5:00 PM'] },
        editorialSummary: { text: 'Fridge specialists.' },
        delivery: false,
        photos: [{ name: `places/${PLACE_ID}/photos/AUy1`, widthPx: 4000, heightPx: 3000 }],
      },
    });
    const { client } = await connectClient(
      testConfig(),
      READ,
      apisWith({ places: { get } }),
      'places',
    );
    const out = text(
      await client.callTool({
        name: 'places_get_place',
        arguments: { placeId: `places/${PLACE_ID}` },
      }),
    );
    expect(get.mock.calls[0]![0].name).toBe(`places/${PLACE_ID}`);
    expect(get.mock.calls[0]![1].headers['X-Goog-FieldMask']).toBe(fieldMask('full', ''));
    expect(out).toContain('Monday: 8:00 AM – 5:00 PM');
    expect(out).toContain(`places/${PLACE_ID}/photos/AUy1`);
    expect(out).toContain('Fridge specialists.');

    const bad = await client.callTool({ name: 'places_get_place', arguments: { placeId: '../x' } });
    expect(bad.isError).toBe(true);
  });

  it('returns reviews and says Google caps them', async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        displayName: { text: 'Cold Co' },
        rating: 4.8,
        userRatingCount: 212,
        reviews: [
          {
            rating: 5,
            relativePublishTimeDescription: 'a month ago',
            authorAttribution: { displayName: 'Sam' },
            text: { text: 'Fixed our | fridge fast' },
          },
        ],
      },
    });
    const { client } = await connectClient(
      testConfig(),
      READ,
      apisWith({ places: { get } }),
      'places',
    );
    const out = text(
      await client.callTool({ name: 'places_get_reviews', arguments: { placeId: PLACE_ID } }),
    );
    expect(get.mock.calls[0]![1].headers['X-Goog-FieldMask']).toContain('reviews');
    expect(out).toContain('rating 4.8 from 212 reviews');
    expect(out).toContain('| Sam | 5 | a month ago | Fixed our \\| fridge fast |');
    expect(out).toContain('at most 5 reviews');
  });

  it('resolves a photo reference without a redirect', async () => {
    const getMedia = vi
      .fn()
      .mockResolvedValue({ data: { photoUri: 'https://lh3.googleusercontent.com/p/abc' } });
    const { client } = await connectClient(
      testConfig(),
      READ,
      apisWith({ places: { photos: { getMedia } } }),
      'places',
    );
    const photoName = `places/${PLACE_ID}/photos/AUy1`;
    const out = text(
      await client.callTool({
        name: 'places_get_photo',
        arguments: { photoName, maxWidthPx: 400 },
      }),
    );
    expect(getMedia).toHaveBeenCalledWith({
      name: `${photoName}/media`,
      maxWidthPx: 400,
      skipHttpRedirect: true,
    });
    expect(out).toContain('https://lh3.googleusercontent.com/p/abc');
    const bad = await client.callTool({
      name: 'places_get_photo',
      arguments: { photoName: 'https://evil.example/x' },
    });
    expect(bad.isError).toBe(true);
  });
});

describe('places API key', () => {
  let stub: Server | undefined;
  afterEach(() => {
    stub?.close();
    stub = undefined;
  });

  async function startStub() {
    const seen: IncomingMessage[] = [];
    stub = createServer((req, res) => {
      seen.push(req);
      req.resume();
      res.setHeader('content-type', 'application/json');
      if (req.headers['x-goog-api-key'] !== 'secret-key-123') {
        res.statusCode = 400;
        res.end(
          JSON.stringify({
            error: {
              code: 400,
              message: 'API key not valid. Please pass a valid API key.',
              details: [{ reason: 'API_KEY_INVALID' }],
            },
          }),
        );
        return;
      }
      res.end(JSON.stringify({ places: [coldCo] }));
    });
    await new Promise<void>((resolve) => stub!.listen(0, '127.0.0.1', resolve));
    return { seen, rootUrl: `http://127.0.0.1:${(stub!.address() as AddressInfo).port}/` };
  }

  it('sends the key and field mask as headers, never in the URL', async () => {
    const { seen, rootUrl } = await startStub();
    const provider = createPlacesApisProvider(() => 'secret-key-123', { rootUrl });
    const { client } = await connectClient(testConfig(), READ, await provider(), 'places');
    const out = text(
      await client.callTool({ name: 'places_search_text', arguments: { query: 'fridge repair' } }),
    );
    expect(out).toContain('Cold Co Refrigeration');
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/v1/places:searchText');
    expect(req.url).not.toContain('secret-key-123');
    expect(req.headers['x-goog-api-key']).toBe('secret-key-123');
    expect(req.headers['x-goog-fieldmask']).toBe(
      fieldMask('standard', 'places.', ['nextPageToken']),
    );
  });

  it('explains a rejected key without echoing it', async () => {
    const { rootUrl } = await startStub();
    const provider = createPlacesApisProvider(() => 'wrong-key-456', { rootUrl });
    const { client } = await connectClient(testConfig(), READ, await provider(), 'places');
    const res = await client.callTool({
      name: 'places_search_text',
      arguments: { query: 'fridge repair' },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('GOOGLE_PLACES_API_KEY');
    expect(text(res)).not.toContain('wrong-key-456');
    // A key that ends up inside an error message is redacted.
    expect(describeError(new Error('request failed for wrong-key-456'))).toBe(
      'Error: request failed for [redacted]',
    );
  });

  it('tells the owner to set the key when it is missing', async () => {
    const provider = createPlacesApisProvider(() => undefined);
    await expect(provider()).rejects.toThrow(/GOOGLE_PLACES_API_KEY/);
    expect(describeError(await provider().catch((e: unknown) => e))).toContain(
      'GOOGLE_PLACES_API_KEY',
    );
  });
});
