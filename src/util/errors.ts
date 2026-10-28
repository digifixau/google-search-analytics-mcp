import { GoogleNotConnectedError } from '../google/auth.js';

/** Secret values (API keys) that must never appear in an error message. */
const secrets = new Set<string>();
export function registerSecret(value: string): void {
  if (value) secrets.add(value);
}
function redact(message: string): string {
  let out = message;
  for (const secret of secrets) out = out.split(secret).join('[redacted]');
  return out;
}

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

/**
 * True when Google refused the stored refresh token (expired, revoked, or a Workspace re-auth policy).
 * Google reports this from its token endpoint as `invalid_grant` with a description such as
 * "Token has been expired or revoked."; nothing but reconnecting fixes it.
 */
export function isRevokedGoogleToken(error: unknown): boolean {
  const e = error as GaxiosLikeError;
  const data = e?.response?.data;
  const code = typeof data?.error === 'string' ? data.error : undefined;
  const text = [code, data?.error_description, e?.message].filter(Boolean).join(' ');
  return (
    code === 'invalid_grant' ||
    /invalid_grant|invalid_rapt|expired or revoked|reauth related error/i.test(text)
  );
}

const REVOKED_MESSAGE =
  "Google no longer accepts this MCP's saved sign-in (the token expired or was revoked). The server owner must open /setup and click Reconnect on this MCP's card (or run `google-auth --connector <id>` for local use). MCPs connected with other Google accounts are not affected. If this happens about every 7 days, the Google OAuth consent screen is still in Testing: publish it, then reconnect.";

/** Turns Google API and internal errors into short, actionable messages for the model and the user. */
export function describeError(error: unknown): string {
  return redact(describe(error));
}

function describe(error: unknown): string {
  if (error instanceof ToolInputError) return `Invalid input: ${error.message}`;
  if (error instanceof AccessDeniedError) return `Access denied by server policy: ${error.message}`;
  if (error instanceof GoogleNotConnectedError) return error.message;
  if (isRevokedGoogleToken(error)) return REVOKED_MESSAGE;

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

  if (
    /(GCP|Cloud) project.*not registered|not registered.*(GCP|Cloud) project|developer registration/i.test(
      googleMessage,
    )
  ) {
    return 'This Google Cloud project is not registered with the Merchant Center account yet. Run merchant_register_gcp_project once for this account (read-write connection), then retry.';
  }
  const details =
    typeof data?.error === 'object' && data.error?.details
      ? JSON.stringify(data.error.details)
      : '';
  if (
    /API[_ ]KEY[_ ](INVALID|EXPIRED)|API key (not valid|expired)/i.test(googleMessage + details)
  ) {
    return `Google rejected the Places API key: ${googleMessage.replace(/\.+$/, '')}. Check GOOGLE_PLACES_API_KEY on the server.`;
  }
  if (
    /API_KEY_(HTTP_REFERRER|IP_ADDRESS|SERVICE|ANDROID_APP|IOS_APP)_BLOCKED|requests from (referer|ip address).*blocked|requests to this API .* are blocked/i.test(
      googleMessage + details,
    )
  ) {
    return `The Places API key's restrictions block this server: ${googleMessage.replace(/\.+$/, '')}. In Google Cloud, set the key's application restriction to None or this server's IP, and its API restriction to "Places API (New)".`;
  }
  if (/billing/i.test(googleMessage) && (status === 403 || status === 400)) {
    return `Google Places needs billing enabled on the Google Cloud project: ${googleMessage}`;
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
      if (
        /forbidden|insufficientPermissions/i.test(googleMessage) &&
        /channel|video|youtube/i.test(googleMessage)
      ) {
        return `YouTube denied access (403): ${googleMessage}. The connected Google account must own or manage this channel; to switch to a Brand Account channel, reconnect Google on /setup and pick it.`;
      }
      return `Google denied access (403): ${googleMessage}. Check that the connected account or service account has permission on this property.`;
    case 404:
      return `Not found (404): ${googleMessage}. Check the ID or name (the matching list tool shows valid values).`;
    case 429:
      return `Google API quota exceeded (429): ${googleMessage}. Wait and retry, or narrow the request.`;
    default:
      return status ? `Google API error (${status}): ${googleMessage}` : `Error: ${googleMessage}`;
  }
}
