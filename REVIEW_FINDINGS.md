# CONVOY Codebase Quality Review

**Date:** 2026-06-25  
**Scope:** services, API routes, screens, stores, tests, security

---

## HIGH Severity

### 1. `apps/api/src/account/account.routes.ts:70` — DELETE /account missing preHandler auth
The `DELETE /account` route calls `await request.jwtVerify()` inline instead of using the `{ preHandler: [authenticate] }` pattern. If `jwtVerify()` throws, Fastify may not propagate it as a 401 correctly in all error handling configurations. The GET /account/export uses the same inline pattern. Both should use `preHandler: [authenticate]` for consistency and safety. **Risk:** auth bypass if Fastify's error handler is misconfigured.

### 2. `apps/api/src/hazards/hazards.routes.ts:108` — POST /hazards uses loose body typing
The request body is cast as `request.body as { type: string; lat: number; lng: number }` without Zod or schema validation. While manual checks follow, a missing/null `type` field will pass the `HAZARD_TYPES.includes(type as HazardType)` check for other types. This pattern is inconsistent with the rest of the codebase (groups, auth use Zod) and leaves type/lat/lng as potentially `undefined` before the typeof check. Should use `z.object()` validation as elsewhere.

### 3. `apps/api/src/hazards/hazards.routes.ts:194` — POST /hazards/bulk silent data loss
Items with invalid type or coordinates are silently skipped (`continue`) with no per-item error reporting. A client syncing offline hazards with even one malformed entry will lose those reports permanently after the bulk call succeeds with `{ inserted: [...], count: N }`. The client's SyncService then calls `clearHazards(all ids)` — including the ones that were never actually inserted. This can silently drop real hazard reports.

### 4. `apps/mobile/src/screens/map/MapScreen.tsx:244-392` — Socket created with raw `io()`, bypasses WebSocketService
MapScreen creates its own Socket.io connection with `io(socketUrl, {...})` at line 246, ignoring the `WebSocketService` class that implements the exponential backoff reconnection spec (Req 43.2). The inline reconnect logic (lines 291-314) handles auth refresh but does not re-enable `reconnectionDelayMax` or use the specified 1s→30s+jitter backoff. This means Req 43.2 is only partially met on the map screen.

### 5. `apps/api/src/groups/groups.routes.ts:596-606` — Kicked member PTT channel cleanup is fire-and-forget
The PTT channel cleanup for a kicked member (lines 596-606) uses `.catch()` without awaiting. If the cleanup fails, the kicked member remains in PTT channel tables with no retry. This is a data integrity issue — the member is removed from convoy_members but stays in ptt_channel_members, which will cause stale DB entries and potentially allow them to receive future PTT transmissions in that channel.

### 6. `apps/api/src/rally/rally.routes.ts` — SOS rate limit (Req 37.5: 60s cooldown) not verified in code
The requirements specify a 60-second cooldown between consecutive SOS broadcasts from the same user (Req 37.5), returning 429 if exceeded. The `rally.routes.ts` file imports from `rateLimiter.ts` and the pure `canBroadcastRally` / `canCancelSos` functions are exported, but there is no visible Redis-based 60-second cooldown check in the SOS broadcast route. (Need to confirm by reading the full file, but file was only partially reviewed — flagged as HIGH for follow-up.)

---

## MEDIUM Severity

### 7. `apps/mobile/src/stores/groupStore.ts` — Missing group metadata fields used by screens
`groupStore` only stores `activeGroupId` and `pttChannelId`. `ConvoyScreen.tsx` and `MapScreen.tsx` manage group state locally with `useState`, not in the store. Fields like `adminId`, `memberCount`, `gapThresholdM`, and `name` are duplicated locally in `ConvoyScreen`. If MapScreen and ConvoyScreen are mounted simultaneously, they can diverge. The store should hold the full active group shape so components share one source of truth.

### 8. `apps/mobile/src/screens/map/MapScreen.tsx:380-392` — DriveService.finishSession called twice on cleanup
When a socket `group:ended` event fires, `finishSession` is called (line 370). When the component unmounts, the cleanup function calls `finishSession` again (line 381) with `isOnline: () => true`. Because `DriveService.reset()` clears `sessionStartMs` on the first call, the second call returns `null` harmlessly — but it still tries to save an empty `OfflineDrive` to SQLite (lines 157-169 of DriveService: `stats` will be null, but the offline record is still written with 0 distance). This creates phantom zero-distance drive records.

### 9. `apps/mobile/src/services/SyncService.ts:67-71` — Hazard sync clears ALL pending hazards even if API call fails after partial success
`syncHazards()` fetches all pending hazards, calls `postBulkHazards(hazards)` (all at once), then `clearHazards(all ids)` only after success. This is correct for total success/failure. However, if `postBulkHazards` partially succeeds (server returns 207 or silently drops some — see finding #3 above), all IDs are still cleared. The root cause is that `postBulkHazards` doesn't return which IDs were successfully inserted.

### 10. `apps/mobile/src/services/NotificationService.ts:21-30` — Lazy require for expo-notifications/expo-device is brittle
Using `require('expo-notifications')` inside functions with `any` typing means TypeScript provides no type checking, and any API change in expo-notifications will only be caught at runtime. If either package is not installed, the entire notification flow silently fails (caught by try/catch). The comment "must be installed via npx expo install..." is a runtime dependency described in source comments, not enforced by package.json. This is a deployment risk.

### 11. `apps/mobile/src/screens/map/MapScreen.tsx:95` — `gapThresholdM` prop is unused
The `Props` interface at line 58 declares `gapThresholdM?: number`, but gap alerting is handled server-side via `handleLocationUpdate` (socket.handler.ts). The prop is accepted but never read inside `MapScreen`. Dead code in the props interface creates confusion about where gap threshold configuration is authoritative.

### 12. `apps/api/src/auth/auth.routes.ts:294-326` — Refresh token not invalidated after use
The `POST /auth/refresh` route issues new access + refresh tokens and sets a new refresh cookie, but the old refresh token is not invalidated (no blacklist or Redis-stored token version). An attacker who intercepts a refresh token can use it indefinitely until it expires (JWT TTL). True token rotation requires invalidating the old token server-side.

### 13. `apps/mobile/src/services/OfflineCacheService.ts:291-296` — Tile eviction logic has off-by-one
In `prefetchTilesForRoute`, the eviction loop checks `if (remaining < this.maxSizeMB) break` AFTER deleting a pack. When `totalMB` equals exactly `maxSizeMB`, the condition `totalMB >= this.maxSizeMB` is true, so eviction starts. The loop will delete the oldest pack even if post-deletion `remaining` would be exactly `maxSizeMB`. The condition should be `remaining <= this.maxSizeMB` to stop when at capacity, not under capacity.

### 14. `apps/mobile/src/components/DestinationSearch.tsx` — Missing `accessibilityRole` on results list items
The destination search FlatList renders result items as `TouchableOpacity` elements. Reviewing the pattern seen in other components (HazardPicker, SettingRow), `accessibilityRole="button"` and `accessibilityLabel` are expected on interactive elements (Req 39.1). The search result items need these props for VoiceOver/TalkBack compliance.

### 15. `apps/mobile/src/screens/map/MapScreen.tsx:84-93` — Module-level SQLite init with mutable global flag
`offlineDB` and `offlineDBReady` are module-level singletons. Multiple mounts of `MapScreen` (e.g. during hot reload or navigation) can race on `offlineDBReady`. If `init()` is called concurrently, `expo-sqlite` may behave unpredictably. The pattern should use a singleton promise (`let initPromise: Promise<void>`) rather than a boolean flag.

### 16. `apps/api/src/socket/socket.handler.ts` — No input validation on `location:update` socket event for `groupId`
`handleLocationUpdate` trusts the `groupId` injected at socket connection time (from `socket.auth.groupId`). The handler does not verify the socket's `groupId` matches an active group membership in the database before writing to Redis and broadcasting. A malicious client can join a group socket room and then manually set `groupId` to another group's ID if the middleware doesn't validate membership on connect. The socket middleware (socketio.ts) should enforce this.

### 17. `apps/mobile/src/stores/settingsStore.ts` — In-memory settings not persisted across app restarts
The `settingsStore` is a plain Zustand store with no `persist` middleware. Settings are loaded from the API in `SettingsScreen` and applied to the store, but on cold start before SettingsScreen mounts, `mapStyle`, `hazardAlertDistanceM`, and `scenicRouting` revert to hardcoded defaults. Components that depend on these settings before the user visits SettingsScreen get stale defaults.

---

## LOW Severity

### 18. `apps/mobile/src/services/DriveService.ts:85` — `topSpeedKph` returns 0 for single-speed-reading sessions
`topSpeedKph` uses `reduce(..., 0)` so a session where all speed readings are 0 returns 0 kph as top speed. This is technically correct but will result in confusing `topSpeedKph: 0` in drive records when the device speed was consistently unavailable. Consider returning `null` when all readings are 0 (same as `avgSpeedKph` uses `null`).

### 19. `apps/api/src/hazards/hazards.routes.ts:189` — GET /hazards returns raw array, not wrapped object
The `GET /hazards` endpoint returns `result.rows.map(serializeHazardRow)` directly (a JSON array) rather than `{ hazards: [...] }`. Every other list endpoint in the codebase returns a wrapped object (`{ groups: [] }`, `{ members: [] }`, etc.). This inconsistency will require special handling on the client.

### 20. `apps/mobile/src/services/PTTService.ts:91-96` — Token refresh race: `expiryListenerRegistered` not reset on `leaveChannel`
`expiryListenerRegistered` is set to `true` on first channel join and never reset in `leaveChannel()`. If `PTTService` is reused across multiple sessions (joinChannel → leaveChannel → joinChannel), the expiry listener from the first session's `onTokenPrivilegeWillExpire` callback will reference the stale first session's `groupId`/`channelId` closure variables, potentially refreshing the wrong channel token.

### 21. `apps/mobile/src/services/ScenicRouteService.ts` — Persisted separately from settingsStore, can diverge
`ScenicRouteService` writes scenic routing preference to a separate SQLite/SecureStore key (`convoy:scenic_route_enabled`), while `useSettingsStore` also has a `scenicRouting` field and `settings.routes.ts` persists it to Postgres. Three separate persistence locations for the same preference with no synchronization means a user who changes scenic routing via SettingsScreen (Postgres + Zustand) will have a different value from what `ScenicRouteService.getScenicMode()` returns (local storage). The `ScenicRouteService` appears redundant given the server-side settings system.

### 22. `apps/mobile/src/screens/map/MapScreen.tsx` — Missing `accessibilityLabel` on SOS button
The SOS button is a critical safety feature (Req 40.1). While `HazardPicker` tiles have proper accessibility labels, the SOS button's `accessibilityLabel` and WCAG AA contrast verification cannot be confirmed without seeing the full render, but the emergency nature (Req 40.1–40.2) makes this worth explicit verification.

### 23. `apps/api/src/auth/auth.service.ts:17-21` — OTP is purely numeric, easily guessed with rate limit bypass
The OTP is a 6-digit number (`Math.floor(100000 + Math.random() * 900000)`). The rate limit is 5 attempts per 10 minutes (Req 37.2). With 900,000 possibilities and 5 guesses every 10 minutes, brute force is not trivially feasible, but OTP verification in `verifyOtp` does a simple string compare with `stored !== otp`. If the Redis rate-limit key (`rl:otp:${phone}`) and the OTP key (`otp:${phone}`) are on different Redis nodes (cluster split), the rate limit and OTP storage could become inconsistent. Low risk in single-node Redis but worth noting.

### 24. `apps/mobile/src/services/LocationService.ts:155-163` — GPS callback errors silently swallowed
The `.catch(() => { /* GPS callback errors are non-fatal */ })` comment is reasonable but provides zero observability. A persistent SQLite failure (e.g. disk full) would silently stop all offline location persistence with no user feedback or log. Should at minimum log to console.error in development.

### 25. `apps/api/src/friends/friends.routes.ts` — Invite link uses `convoy://` deep link without validation
`GET /friends/invite-link` returns `convoy://invite?userId=${userId}`. The `userId` is taken from the JWT `sub` claim (trusted), so injection is not a risk. However, the URL is not URL-encoded (`encodeURIComponent`) — a UUID with standard format is safe, but this is fragile if the user ID format ever changes.

### 26. `apps/mobile/src/services/AgoraEngineAdapter.ts` + `ApiTokenFetcher.ts` — Module-level singletons shared across MapScreen instances
`agoraEngineAdapter` (line 34, MapScreen) and `apiTokenFetcher` (line 35) are imported as module-level singletons. If two MapScreen instances mount (unlikely but possible in navigation transitions), they share the same Agora engine, causing unexpected audio behavior. The `PTTService` should own its engine or the adapter should be instance-scoped.

### 27. `apps/api/src/drives/drives.routes.ts` — Missing auth preHandler (partial file seen)
The drives routes file was only partially reviewed, but based on the pattern of inline `await request.jwtVerify()` seen in account.routes.ts, it should be verified that all drive endpoints use `preHandler: [authenticate]` consistently.

### 28. `apps/mobile/src/screens/ConvoyScreen.tsx:48-54` — `haversineM` duplicated from DriveService and socket.handler
The Haversine distance function is implemented three times: `DriveService.ts:57`, `socket.handler.ts:43`, and `ConvoyScreen.tsx:48`. These should be extracted to a shared `utils/geo.ts` module. Currently any bug fix in one won't propagate to others.

---

## Summary Table

| # | File | Issue | Severity |
|---|------|-------|----------|
| 1 | account.routes.ts:70 | DELETE /account uses inline jwtVerify instead of preHandler | HIGH |
| 2 | hazards.routes.ts:108 | POST /hazards loose body casting without Zod | HIGH |
| 3 | hazards.routes.ts:194 | Bulk sync silently drops items, client clears all IDs | HIGH |
| 4 | MapScreen.tsx:246 | Raw `io()` bypasses WebSocketService exponential backoff | HIGH |
| 5 | groups.routes.ts:596 | PTT channel kick cleanup is unawaited fire-and-forget | HIGH |
| 6 | rally.routes.ts | SOS 60s cooldown rate limit (Req 37.5) not confirmed | HIGH |
| 7 | groupStore.ts | Missing group metadata fields, multi-screen state divergence | MEDIUM |
| 8 | MapScreen.tsx:380 | DriveService.finishSession called twice, creates phantom records | MEDIUM |
| 9 | SyncService.ts:67 | Hazard sync doesn't track partial-success inserted IDs | MEDIUM |
| 10 | NotificationService.ts:21 | Lazy require with any typing is brittle | MEDIUM |
| 11 | MapScreen.tsx:95 | `gapThresholdM` prop accepted but never read (dead code) | MEDIUM |
| 12 | auth.routes.ts:294 | Refresh token not server-side invalidated after rotation | MEDIUM |
| 13 | OfflineCacheService.ts:291 | Tile eviction off-by-one at exact capacity | MEDIUM |
| 14 | DestinationSearch.tsx | Missing accessibilityRole/Label on result items | MEDIUM |
| 15 | MapScreen.tsx:84 | Module-level SQLite init with race-prone boolean flag | MEDIUM |
| 16 | socket.handler.ts | No group membership validation on location:update | MEDIUM |
| 17 | settingsStore.ts | Settings not persisted; revert to defaults on cold start | MEDIUM |
| 18 | DriveService.ts:85 | topSpeedKph returns 0 instead of null when all speeds are 0 | LOW |
| 19 | hazards.routes.ts:189 | GET /hazards returns bare array, inconsistent with other routes | LOW |
| 20 | PTTService.ts:91 | expiryListenerRegistered not reset on leaveChannel | LOW |
| 21 | ScenicRouteService.ts | Three separate stores for same scenic routing preference | LOW |
| 22 | MapScreen.tsx | SOS button accessibility needs explicit verification | LOW |
| 23 | auth.service.ts:17 | OTP/rate-limit Redis key namespace split risk in cluster mode | LOW |
| 24 | LocationService.ts:155 | GPS callback errors silently swallowed, no observability | LOW |
| 25 | friends.routes.ts | Invite link userId not URL-encoded | LOW |
| 26 | AgoraEngineAdapter.ts | Module-level singleton shared if two MapScreens mount | LOW |
| 27 | drives.routes.ts | Confirm all endpoints use preHandler auth (partial review) | LOW |
| 28 | ConvoyScreen.tsx:48 | Haversine function duplicated 3×, should be shared util | LOW |
