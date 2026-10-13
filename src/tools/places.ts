import { z } from 'zod';
import type { places_v1 } from 'googleapis';
import type { GoogleApis } from '../google/clients.js';
import { ToolInputError } from '../util/errors.js';
import { jsonResult, round, tableResult, textResult, type Row } from '../util/output.js';
import { defineTool } from './registry.js';

type Place = places_v1.Schema$GoogleMapsPlacesV1Place;

/** Google bills Places calls by the fields requested, so tools build the field mask from a preset. */
export const DETAIL_FIELDS = {
  basic: [
    'id',
    'displayName',
    'formattedAddress',
    'location',
    'types',
    'primaryType',
    'businessStatus',
    'googleMapsUri',
  ],
  standard: [
    'rating',
    'userRatingCount',
    'priceLevel',
    'websiteUri',
    'nationalPhoneNumber',
    'regularOpeningHours',
  ],
  full: [
    'editorialSummary',
    'internationalPhoneNumber',
    'photos',
    'delivery',
    'dineIn',
    'takeout',
    'curbsidePickup',
    'reservable',
    'accessibilityOptions',
  ],
} as const;

export type Detail = keyof typeof DETAIL_FIELDS;

const detailSchema = (fallback: Detail) =>
  z
    .enum(['basic', 'standard', 'full'])
    .default(fallback)
    .describe(
      'How much to fetch. Google bills by the fields requested: "basic" is the cheapest (name, address, location, types, status, Maps link); "standard" adds rating, review count, price level, website, phone and opening hours; "full" adds the summary, photos, service options and accessibility. ' +
        `Default "${fallback}".`,
    );

/** Field paths for a preset; `prefix` is `places.` for search responses and empty for a single place. */
export function fieldMask(detail: Detail, prefix: string, extra: string[] = []): string {
  const order: Detail[] =
    detail === 'basic'
      ? ['basic']
      : detail === 'standard'
        ? ['basic', 'standard']
        : ['basic', 'standard', 'full'];
  return [...order.flatMap((d) => DETAIL_FIELDS[d].map((f) => `${prefix}${f}`)), ...extra].join(
    ',',
  );
}

const headers = (mask: string) => ({ headers: { 'X-Goog-FieldMask': mask } });

/** Places tools only run on the Places MCP, which always provides the Places client. */
function placesOf(apis: GoogleApis): places_v1.Places {
  if (!apis.places) throw new ToolInputError('The Places client is not available on this MCP.');
  return apis.places;
}

const placeIdSchema = z
  .string()
  .transform((v) => v.trim().replace(/^places\//, ''))
  .pipe(z.string().regex(/^[A-Za-z0-9_-]{10,300}$/, 'Expected a place ID like ChIJ…'))
  .describe(
    'Place ID from places_search_text or places_search_nearby (with or without "places/").',
  );

const latitude = z.number().min(-90).max(90).describe('Latitude, -90 to 90.');
const longitude = z.number().min(-180).max(180).describe('Longitude, -180 to 180.');
const radius = z.number().positive().max(50_000).describe('Radius in meters, up to 50000 (50 km).');
const maxResults = z
  .number()
  .int()
  .min(1)
  .max(20)
  .default(10)
  .describe('Number of places to return, 1-20. Default 10.');
const languageCode = z
  .string()
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, 'Expected a language code like "en" or "en-AU"')
  .optional()
  .describe('Language for names and addresses, e.g. "en" or "en-AU".');
const regionCode = z
  .string()
  .regex(/^[A-Za-z]{2}$/, 'Expected a two-letter region code like "AU"')
  .optional()
  .describe('Two-letter region code that biases formatting and ranking, e.g. "AU".');

const PRICE_LEVELS = ['inexpensive', 'moderate', 'expensive', 'very_expensive'] as const;

const text = (value: { text?: string | null } | undefined) => value?.text ?? undefined;
const priceLabel = (level: string | null | undefined) =>
  level ? level.replace(/^PRICE_LEVEL_/, '').toLowerCase() : undefined;

/** A flat, table-friendly view of a place for the requested detail level. */
export function placeRow(place: Place, detail: Detail): Row {
  const row: Row = {
    placeId: place.id,
    name: text(place.displayName),
    address: place.formattedAddress,
    location: place.location ? `${place.location.latitude},${place.location.longitude}` : undefined,
    type: place.primaryType ?? place.types?.[0],
    status: place.businessStatus,
    mapsUrl: place.googleMapsUri,
  };
  if (detail !== 'basic') {
    row.rating = place.rating;
    row.reviews = place.userRatingCount;
    row.price = priceLabel(place.priceLevel);
    row.website = place.websiteUri;
    row.phone = place.nationalPhoneNumber;
  }
  return row;
}

const COLUMNS: Record<Detail, string[]> = {
  basic: ['placeId', 'name', 'address', 'location', 'type', 'status', 'mapsUrl'],
  standard: [
    'placeId',
    'name',
    'address',
    'type',
    'rating',
    'reviews',
    'price',
    'website',
    'phone',
    'status',
  ],
  full: [
    'placeId',
    'name',
    'address',
    'type',
    'rating',
    'reviews',
    'price',
    'website',
    'phone',
    'status',
  ],
};

const COST_NOTE = 'Each Places call is billed by Google; richer "detail" levels cost more.';

/** `places.reviews` is requested only for a "full" search that asked for reviews. */
const reviewField = (args: { detail: Detail; includeReviews: boolean }) =>
  args.detail === 'full' && args.includeReviews ? ['places.reviews'] : [];

/** Everything known about one place at the given detail level (shared by get_place and full searches). */
export function placeDetail(p: Place, detail: Detail, maxPhotos = 10): Row {
  return {
    ...placeRow(p, detail),
    priceLevel: priceLabel(p.priceLevel),
    openingHours: p.regularOpeningHours?.weekdayDescriptions,
    internationalPhone: p.internationalPhoneNumber,
    summary: text(p.editorialSummary),
    serviceOptions:
      detail === 'full'
        ? {
            delivery: p.delivery,
            dineIn: p.dineIn,
            takeout: p.takeout,
            curbsidePickup: p.curbsidePickup,
            reservable: p.reservable,
          }
        : undefined,
    accessibility: p.accessibilityOptions,
    photos: p.photos?.slice(0, maxPhotos).map((ph) => ({
      photoName: ph.name,
      widthPx: ph.widthPx,
      heightPx: ph.heightPx,
    })),
  };
}

/** The reviews Google returns for a place (at most 5), with the text cut to `maxChars`. */
export function reviewRows(p: Place, maxChars: number): Row[] {
  return (p.reviews ?? []).slice(0, 5).map((r) => ({
    author: r.authorAttribution?.displayName,
    rating: r.rating,
    when: r.relativePublishTimeDescription,
    review: (text(r.text) ?? '').slice(0, maxChars),
  }));
}

const includeReviewsSchema = z
  .boolean()
  .default(false)
  .describe(
    'Only with detail "full": also return up to 5 reviews per place in this same call (no extra request is billed; the reviews field is in the same Google tier as "full"). Off by default because it makes the response long.',
  );

/** Search response for detail "full": one JSON entry per place, so no per-place follow-up call is needed. */
function fullSearchResult(
  title: string,
  found: Place[],
  includeReviews: boolean,
  nextPageToken?: string | null,
) {
  return jsonResult(title, {
    places: found.map((p) => ({
      ...placeDetail(p, 'full', 3),
      reviews: includeReviews ? reviewRows(p, 300) : undefined,
    })),
    nextPageToken: nextPageToken ?? undefined,
    note: `${COST_NOTE} This one request already includes details and photo references; pass a photoName to places_get_photo only for the photos you need, since each photo is a separate billed call.`,
  });
}

export const placesSearchText = defineTool({
  name: 'places_search_text',
  title: 'Search places by text',
  description:
    'Finds places with a free-text query such as "fridge repair Melbourne" or "pizza near Fitzroy". Optionally bias towards a point, filter by type, rating, price or open-now. Returns place IDs for places_get_place, places_get_reviews and places_get_photo. ' +
    'The cheapest way to research several places is ONE search with detail "full" (add includeReviews for reviews): it returns details and photo references for every result in a single billed request, so no places_get_place call per place is needed. ' +
    COST_NOTE,
  access: 'read',
  toolset: 'places',
  inputSchema: {
    query: z.string().trim().min(1).max(300).describe('What to search for, including the area.'),
    includedType: z
      .string()
      .regex(/^[a-z_]+$/, 'Expected a Places type like "restaurant" or "electrician"')
      .optional()
      .describe('Only places of this type (Google Places "Table A" type), e.g. "restaurant".'),
    openNow: z.boolean().optional().describe('Only places open right now.'),
    minRating: z
      .number()
      .min(0)
      .max(5)
      .optional()
      .describe('Only places rated at least this (0-5).'),
    priceLevels: z.array(z.enum(PRICE_LEVELS)).max(4).optional(),
    nearLatitude: latitude.optional(),
    nearLongitude: longitude.optional(),
    nearRadiusMeters: radius.optional(),
    maxResults,
    pageToken: z
      .string()
      .optional()
      .describe('nextPageToken from the previous call, to get the next page.'),
    detail: detailSchema('standard'),
    includeReviews: includeReviewsSchema,
    languageCode,
    regionCode,
  },
  handler: async (args, ctx) => {
    const near = [args.nearLatitude, args.nearLongitude, args.nearRadiusMeters];
    if (near.some((v) => v !== undefined) && near.some((v) => v === undefined)) {
      throw new ToolInputError(
        'To bias towards a point, give nearLatitude, nearLongitude and nearRadiusMeters together.',
      );
    }
    const places = placesOf(await ctx.apis());
    const res = await places.places.searchText(
      {
        requestBody: {
          textQuery: args.query,
          includedType: args.includedType,
          openNow: args.openNow,
          minRating: args.minRating,
          priceLevels: args.priceLevels?.map((p) => `PRICE_LEVEL_${p.toUpperCase()}`),
          pageSize: args.maxResults,
          pageToken: args.pageToken,
          languageCode: args.languageCode,
          regionCode: args.regionCode,
          locationBias:
            args.nearLatitude === undefined
              ? undefined
              : {
                  circle: {
                    center: { latitude: args.nearLatitude, longitude: args.nearLongitude },
                    radius: args.nearRadiusMeters,
                  },
                },
        },
      },
      headers(fieldMask(args.detail, 'places.', ['nextPageToken', ...reviewField(args)])),
    );
    const title = `Places for "${args.query}" (${res.data.places?.length ?? 0})`;
    if (args.detail === 'full') {
      return fullSearchResult(
        title,
        res.data.places ?? [],
        args.includeReviews,
        res.data.nextPageToken,
      );
    }
    const rows = (res.data.places ?? []).map((p) => placeRow(p, args.detail));
    const notes = [COST_NOTE];
    if (res.data.nextPageToken)
      notes.push(`More results: call again with pageToken "${res.data.nextPageToken}".`);
    return tableResult(title, rows, { columns: COLUMNS[args.detail], notes });
  },
});

export const placesSearchNearby = defineTool({
  name: 'places_search_nearby',
  title: 'Search places nearby',
  description:
    'Finds places within a radius of a point, optionally limited to given place types (e.g. "restaurant", "electrician"), ranked by popularity or distance. Returns place IDs for places_get_place and others. ' +
    'With detail "full" one search returns details and photo references for every result (add includeReviews for reviews), so no per-place follow-up call is needed. ' +
    COST_NOTE,
  access: 'read',
  toolset: 'places',
  inputSchema: {
    latitude,
    longitude,
    radiusMeters: radius,
    includedTypes: z
      .array(z.string().regex(/^[a-z_]+$/))
      .max(50)
      .optional()
      .describe('Only these Places types, e.g. ["restaurant","cafe"].'),
    excludedTypes: z
      .array(z.string().regex(/^[a-z_]+$/))
      .max(50)
      .optional()
      .describe('Leave out these Places types.'),
    rankBy: z.enum(['popularity', 'distance']).default('popularity'),
    maxResults,
    detail: detailSchema('standard'),
    includeReviews: includeReviewsSchema,
    languageCode,
    regionCode,
  },
  handler: async (args, ctx) => {
    const places = placesOf(await ctx.apis());
    const res = await places.places.searchNearby(
      {
        requestBody: {
          locationRestriction: {
            circle: {
              center: { latitude: args.latitude, longitude: args.longitude },
              radius: args.radiusMeters,
            },
          },
          includedTypes: args.includedTypes,
          excludedTypes: args.excludedTypes,
          rankPreference: args.rankBy.toUpperCase(),
          maxResultCount: args.maxResults,
          languageCode: args.languageCode,
          regionCode: args.regionCode,
        },
      },
      headers(fieldMask(args.detail, 'places.', reviewField(args))),
    );
    const title = `Places within ${args.radiusMeters} m of ${args.latitude},${args.longitude} (${res.data.places?.length ?? 0})`;
    if (args.detail === 'full') {
      return fullSearchResult(title, res.data.places ?? [], args.includeReviews);
    }
    const rows = (res.data.places ?? []).map((p) => placeRow(p, args.detail));
    return tableResult(title, rows, { columns: COLUMNS[args.detail], notes: [COST_NOTE] });
  },
});

export const placesGetPlace = defineTool({
  name: 'places_get_place',
  title: 'Get place details',
  description:
    'Full details for one place ID: address, location, types, status, rating, price level, website, phone, opening hours and (at "full") summary, service options, accessibility and photo references for places_get_photo. Reviews are in places_get_reviews. ' +
    COST_NOTE,
  access: 'read',
  toolset: 'places',
  inputSchema: {
    placeId: placeIdSchema,
    detail: detailSchema('full'),
    languageCode,
    regionCode,
  },
  handler: async (args, ctx) => {
    const places = placesOf(await ctx.apis());
    const res = await places.places.get(
      {
        name: `places/${args.placeId}`,
        languageCode: args.languageCode,
        regionCode: args.regionCode,
      },
      headers(fieldMask(args.detail, '')),
    );
    const p = res.data;
    return jsonResult(
      `${text(p.displayName) ?? args.placeId} (${args.detail} detail)`,
      placeDetail(p, args.detail),
    );
  },
});

export const placesGetReviews = defineTool({
  name: 'places_get_reviews',
  title: 'Get place reviews',
  description:
    "The rating, total review count and the reviews Google returns for a place (at most 5, chosen by Google, so this is a sample and not every review). Billed at Google's highest Places rate.",
  access: 'read',
  toolset: 'places',
  inputSchema: {
    placeId: placeIdSchema,
    languageCode,
  },
  handler: async (args, ctx) => {
    const places = placesOf(await ctx.apis());
    const res = await places.places.get(
      { name: `places/${args.placeId}`, languageCode: args.languageCode },
      headers('id,displayName,rating,userRatingCount,reviews,googleMapsUri'),
    );
    const p = res.data;
    const rows = reviewRows(p, 600);
    return tableResult(
      `${text(p.displayName) ?? args.placeId}: rating ${p.rating ?? 'n/a'} from ${p.userRatingCount ?? 0} reviews`,
      rows,
      {
        notes: [
          'Google returns at most 5 reviews per place; this is a sample, not the full set.',
          ...(p.googleMapsUri ? [`Maps: ${p.googleMapsUri}`] : []),
        ],
      },
    );
  },
});

export const placesGetPhoto = defineTool({
  name: 'places_get_photo',
  title: 'Get place photo URL',
  description:
    'Turns a photoName from places_get_place or a "full" search (like "places/ChIJ…/photos/AUy1…") into an image URL. The URL is a Google image link and does not contain the server\'s API key. Each call is billed by Google.',
  access: 'read',
  toolset: 'places',
  inputSchema: {
    photoName: z
      .string()
      .trim()
      .regex(
        /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/,
        'Expected a photoName like "places/ChIJ…/photos/AUy1…" from places_get_place',
      ),
    maxWidthPx: z.number().int().min(1).max(1600).default(800).describe('Image width, 1-1600 px.'),
  },
  handler: async (args, ctx) => {
    const places = placesOf(await ctx.apis());
    const res = await places.places.photos.getMedia({
      name: `${args.photoName}/media`,
      maxWidthPx: args.maxWidthPx,
      skipHttpRedirect: true,
    });
    if (!res.data.photoUri) throw new ToolInputError('Google returned no image for this photo.');
    return textResult(
      `Photo (max ${round(args.maxWidthPx, 0)} px wide): ${res.data.photoUri}\n\n- ${COST_NOTE}`,
    );
  },
});

export const placesTools = [
  placesSearchText,
  placesSearchNearby,
  placesGetPlace,
  placesGetReviews,
  placesGetPhoto,
];
