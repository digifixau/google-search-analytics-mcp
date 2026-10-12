import {
  google,
  type analyticsadmin_v1alpha,
  type analyticsadmin_v1beta,
  type analyticsdata_v1beta,
  type indexing_v3,
  type searchconsole_v1,
  type tagmanager_v2,
} from 'googleapis';
import type { AuthClient } from 'google-auth-library';

export interface GoogleApis {
  searchconsole: searchconsole_v1.Searchconsole;
  indexing: indexing_v3.Indexing;
  analyticsData: analyticsdata_v1beta.Analyticsdata;
  analyticsAdmin: analyticsadmin_v1beta.Analyticsadmin;
  analyticsAdminAlpha: analyticsadmin_v1alpha.Analyticsadmin;
  tagmanager: tagmanager_v2.Tagmanager;
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
    };
    cached = { auth, apis };
    return apis;
  };
}
