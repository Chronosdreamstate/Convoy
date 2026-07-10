/**
 * Shared geo helpers.
 *
 * Single canonical implementation of the haversine great-circle distance —
 * previously duplicated (with different signatures) in
 * speed-cameras/speed-cameras.routes.ts and socket/socket.handler.ts.
 * Route modules should import from here; socket.handler.ts should adopt this
 * util too (owned by the socket-scope agent).
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/** Haversine great-circle distance between two coordinates, in metres. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δφ = toRad(b.lat - a.lat);
  const Δλ = toRad(b.lng - a.lng);
  const x =
    Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
