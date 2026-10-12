import { GoogleNotConnectedError } from '../google/auth.js';

export class ToolInputError extends Error {}
export class AccessDeniedError extends Error {}

interface GaxiosLikeError {
  status?: number;
  code?: number | string;
  message?: string;
  response?: {
    status?: number;
    data?: {
      error?: { message?: string; status?: string; details?: unknown } | string;
      error_description?: string;
    };
  };
}

/** Turns Google API and internal errors into short, actionable messages for the model and the user. */
export function describeError(error: unknown): string {
  if (error instanceof ToolInputError) return `Invalid input: ${error.message}`;
  if (error instanceof AccessDeniedError) return `Access denied by server policy: ${error.message}`;
  if (error instanceof GoogleNotConnectedError) return error.message;

  const e = error as GaxiosLikeError;
  const status =
    e?.response?.status ?? e?.status ?? (typeof e?.code === 'number' ? e.code : undefined);
  const data = e?.response?.data;
  const googleMessage =
    (typeof data?.error === 'object' ? data.error?.message : undefined) ??
    data?.error_description ??
    (typeof data?.error === 'string' ? data.error : undefined) ??
    e?.message ??
    String(error);

  if (googleMessage.includes('invalid_grant')) {
    return 'Google rejected the stored refresh token (revoked or expired). Reconnect Google via /setup (or run `google-auth`).';
  }
  switch (status) {
    case 400:
      return `Google API rejected the request (400): ${googleMessage}`;
    case 401:
      return `Google authentication failed (401): ${googleMessage}. Reconnect Google via /setup.`;
    case 403:
      if (/insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(googleMessage)) {
        return 'The connected Google account did not grant the scope this tool needs. If ACCESS_MODE or WRITE_TOOLSETS changed, reconnect Google via /setup so the new scopes are granted.';
      }
      if (/has not been used|is disabled|SERVICE_DISABLED/i.test(googleMessage)) {
        return `A required Google API is disabled in your Google Cloud project: ${googleMessage}`;
      }
      return `Google denied access (403): ${googleMessage}. Check that the connected account or service account has permission on this property.`;
    case 404:
      return `Not found (404): ${googleMessage}. Check the site URL / property ID (use gsc_list_sites or ga4_list_properties).`;
    case 429:
      return `Google API quota exceeded (429): ${googleMessage}. Wait and retry, or narrow the request.`;
    default:
      return status ? `Google API error (${status}): ${googleMessage}` : `Error: ${googleMessage}`;
  }
}
