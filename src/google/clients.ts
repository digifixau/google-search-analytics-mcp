import {
  google,
  type analyticsadmin_v1alpha,
  type analyticsadmin_v1beta,
  type analyticsdata_v1beta,
  type indexing_v3,
  type places_v1,
  type searchconsole_v1,
  type tagmanager_v2,
  type youtubeAnalytics_v2,
  type youtube_v3,
  type merchantapi_accounts_v1,
  type merchantapi_datasources_v1,
  type merchantapi_issueresolution_v1,
  type merchantapi_products_v1,
  type merchantapi_promotions_v1,
  type merchantapi_reports_v1,
} from 'googleapis';
import type { AuthClient } from 'google-auth-library';
import { registerSecret } from '../util/errors.js';
import { GoogleNotConnectedError } from './auth.js';

export interface GoogleApis {
  searchconsole: searchconsole_v1.Searchconsole;
  indexing: indexing_v3.Indexing;
  analyticsData: analyticsdata_v1beta.Analyticsdata;
  analyticsAdmin: analyticsadmin_v1beta.Analyticsadmin;
  analyticsAdminAlpha: analyticsadmin_v1alpha.Analyticsadmin;
  tagmanager: tagmanager_v2.Tagmanager;
  youtubeAnalytics: youtubeAnalytics_v2.Youtubeanalytics;
  youtube: youtube_v3.Youtube;
  merchantAccounts: merchantapi_accounts_v1.Merchantapi;
  merchantDataSources: merchantapi_datasources_v1.Merchantapi;
  merchantIssues: merchantapi_issueresolution_v1.Merchantapi;
  merchantProducts: merchantapi_products_v1.Merchantapi;
  merchantPromotions: merchantapi_promotions_v1.Merchantapi;
  merchantReports: merchantapi_reports_v1.Merchantapi;
  /** Only present on the Places MCP, which is authenticated by API key instead of a Google account. */
  places?: places_v1.Places;
}

/** Lazily resolves Google API clients so tools fail with a clear message if Google is not connected. */
export type GoogleApisProvider = () => Promise<GoogleApis>;

export function createGoogleApisProvider(getAuth: () => Promise<AuthClient>): GoogleApisProvider {
  let cached: { auth: AuthClient; apis: GoogleApis } | undefined;
  return async () => {
    const auth = await getAuth();
    if (cached?.auth === auth) return cached.apis;
    // googleapis' types pin their own google-auth-library copy; the runtime objects are identical.
    const options = { auth: auth as never };
    const apis: GoogleApis = {
      searchconsole: google.searchconsole({ version: 'v1', ...options }),
      indexing: google.indexing({ version: 'v3', ...options }),
      analyticsData: google.analyticsdata({ version: 'v1beta', ...options }),
      analyticsAdmin: google.analyticsadmin({ version: 'v1beta', ...options }),
      analyticsAdminAlpha: google.analyticsadmin({ version: 'v1alpha', ...options }),
      tagmanager: google.tagmanager({ version: 'v2', ...options }),
      youtubeAnalytics: google.youtubeAnalytics({ version: 'v2', ...options }),
      youtube: google.youtube({ version: 'v3', ...options }),
      merchantAccounts: google.merchantapi({ version: 'accounts_v1', ...options }),
      merchantDataSources: google.merchantapi({ version: 'datasources_v1', ...options }),
      merchantIssues: google.merchantapi({ version: 'issueresolution_v1', ...options }),
      merchantProducts: google.merchantapi({ version: 'products_v1', ...options }),
      merchantPromotions: google.merchantapi({ version: 'promotions_v1', ...options }),
      merchantReports: google.merchantapi({ version: 'reports_v1', ...options }),
    };
    cached = { auth, apis };
    return apis;
  };
}

/**
 * Places is called with an API key, sent in the `X-Goog-Api-Key` header so it never appears in a URL
 * or log line. Only the Places client exists on this provider: the Places MCP never touches the
 * other Google clients, and has no Google account or token to leak.
 */
export function createPlacesApisProvider(
  getKey: () => string | undefined,
  options: { rootUrl?: string } = {},
): GoogleApisProvider {
  let cached: { key: string; apis: GoogleApis } | undefined;
  return async () => {
    const key = getKey();
    if (!key) {
      throw new GoogleNotConnectedError(
        'The Google Places MCP has no API key. The server owner must set GOOGLE_PLACES_API_KEY and redeploy.',
      );
    }
    if (cached?.key !== key) {
      registerSecret(key);
      const places = google.places({
        version: 'v1',
        headers: { 'X-Goog-Api-Key': key },
        ...(options.rootUrl ? { rootUrl: options.rootUrl } : {}),
      });
      cached = { key, apis: { places } as GoogleApis };
    }
    return cached.apis;
  };
}
