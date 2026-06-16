/** Manages active route state, waypoints, and traffic refresh scheduling. */

export interface LatLng { lat: number; lng: number }

export interface Route {
  distance: number;
  duration: number;
  distanceText: string;
  durationText: string;
  geometry: { type: 'LineString'; coordinates: [number, number][] };
}

export const MAX_WAYPOINTS = 10;
export const TRAFFIC_REFRESH_INTERVAL_MS = 60_000; // 60 seconds (Property 7)

export class RouteService {
  private _waypoints: LatLng[] = [];
  private _routes: Route[] = [];
  private _activeRoute: Route | null = null;
  private _trafficTimer: ReturnType<typeof setInterval> | null = null;

  // ---------------------------------------------------------------------------
  // Waypoints (Property 8: max 10)
  // ---------------------------------------------------------------------------

  get waypoints(): readonly LatLng[] { return this._waypoints; }

  /** Add a waypoint. Throws if already at MAX_WAYPOINTS (Property 8). */
  addWaypoint(point: LatLng): void {
    if (this._waypoints.length >= MAX_WAYPOINTS) {
      throw new RangeError(
        `Cannot add more than ${MAX_WAYPOINTS} waypoints`,
      );
    }
    this._waypoints.push(point);
  }

  removeWaypoint(index: number): void {
    if (index < 0 || index >= this._waypoints.length) return;
    this._waypoints.splice(index, 1);
  }

  reorderWaypoints(from: number, to: number): void {
    if (from < 0 || from >= this._waypoints.length) return;
    if (to < 0 || to >= this._waypoints.length) return;
    const [item] = this._waypoints.splice(from, 1);
    this._waypoints.splice(to, 0, item);
  }

  clearWaypoints(): void { this._waypoints = []; }

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  get routes(): readonly Route[] { return this._routes; }
  get activeRoute(): Route | null { return this._activeRoute; }

  setRoutes(routes: Route[]): void { this._routes = routes; }
  setActiveRoute(index: number): void {
    this._activeRoute = this._routes[index] ?? null;
  }

  // ---------------------------------------------------------------------------
  // Traffic refresh (Property 7: fires every 60 s)
  // ---------------------------------------------------------------------------

  /** Start periodic traffic refresh. Returns the timer id for testing. */
  startTrafficRefresh(onRefresh: () => void): ReturnType<typeof setInterval> {
    this.stopTrafficRefresh();
    this._trafficTimer = setInterval(onRefresh, TRAFFIC_REFRESH_INTERVAL_MS);
    return this._trafficTimer;
  }

  stopTrafficRefresh(): void {
    if (this._trafficTimer !== null) {
      clearInterval(this._trafficTimer);
      this._trafficTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Speed limit (Property 38)
  // ---------------------------------------------------------------------------

  /** True when currentSpeed exceeds the posted limit (Property 38). */
  static isSpeedLimitExceeded(currentSpeedKph: number, postedLimitKph: number): boolean {
    return currentSpeedKph > postedLimitKph;
  }
}
