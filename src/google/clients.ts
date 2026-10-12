import {
  google,
  type analyticsadmin_v1alpha,
  type analyticsadmin_v1beta,
  type analyticsdata_v1beta,
  type indexing_v3,
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
