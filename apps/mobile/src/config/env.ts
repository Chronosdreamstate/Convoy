/**
 * Build-time configuration, resolved once.
 *
 * EXPO_PUBLIC_* values are inlined by Expo when the bundle is built, so a
 * release build that was produced without them cannot recover at runtime — the
 * only useful thing to do is say so loudly.
 *
 * That matters because the old default was `http://localhost:3000`, scattered
 * across a dozen call sites. A production build missing EXPO_PUBLIC_API_URL
 * pointed every request at the handset itself: each one failed with a network
 * error, which the app reports as being offline. The result was an app that
 * looked permanently disconnected with nothing anywhere explaining why.
 * Several screens defaulted to '' instead, which silently produced relative
 * image URLs that can never load in React Native.
 */

const DEV_FALLBACK_API_URL = 'http://localhost:3000';

const RAW_API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';
const RAW_MAPBOX_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';

/**
 * API base URL, e.g. `https://api.convoy.app`. Falls back to localhost only in
 * development, where that is genuinely what a developer wants.
 */
export const API_URL = RAW_API_URL || DEV_FALLBACK_API_URL;

/** `${API_URL}/api/v1` — the prefix every REST route lives under. */
export const API_V1_URL = `${API_URL}/api/v1`;

export const MAPBOX_TOKEN = RAW_MAPBOX_TOKEN;

/** True for a host the device can only reach if the server runs on it. */
function isLoopback(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2|\[::1\])(:|\/|$)/i.test(url);
}

/**
 * Configuration problems that make a RELEASE build unusable. Pure, so it can
 * be tested without building; mirrors the API's productionConfigErrors().
 *
 * Deliberately does NOT include Agora or the OAuth client IDs: PTT voice and
 * social sign-in both degrade gracefully when unset, and phone OTP — the
 * primary sign-in — keeps working.
 */
export function productionConfigErrors(values: {
  apiUrl: string;
  mapboxToken: string;
}): string[] {
  const errors: string[] = [];

  if (!values.apiUrl) {
    errors.push('EXPO_PUBLIC_API_URL is not set — the app has no server to talk to.');
  } else if (isLoopback(values.apiUrl)) {
    errors.push(
      `EXPO_PUBLIC_API_URL points at ${values.apiUrl}, which resolves to the phone itself. ` +
        'Set it to the deployed API URL.',
    );
  } else if (!/^https:\/\//i.test(values.apiUrl)) {
    // iOS App Transport Security blocks cleartext HTTP in release builds, so
    // this would fail on device even though it works in the simulator.
    errors.push(`EXPO_PUBLIC_API_URL must use https:// in a release build (got ${values.apiUrl}).`);
  }

  if (!values.mapboxToken) {
    errors.push('EXPO_PUBLIC_MAPBOX_TOKEN is not set — the map cannot render.');
  } else if (values.mapboxToken.includes('YOUR_MAPBOX')) {
    errors.push('EXPO_PUBLIC_MAPBOX_TOKEN is still the placeholder from .env.example.');
  }

  return errors;
}

/**
 * Errors for THIS build, or [] in development (where localhost and a missing
 * map token are normal).
 */
export function currentConfigErrors(): string[] {
  if (__DEV__) return [];
  return productionConfigErrors({ apiUrl: RAW_API_URL, mapboxToken: RAW_MAPBOX_TOKEN });
}
