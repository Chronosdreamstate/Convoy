# Requirements Document

## Introduction

CONVOY is a mobile and CarPlay application for the car enthusiast community. It provides real-time group navigation, friend location sharing, push-to-talk (PTT) voice communication, road hazard reporting, and traffic-aware routing. The app is designed to be fully usable while driving, with native Apple CarPlay and Android Auto integration and offline support for low-signal conditions.

Target platforms: iOS 16+, Android 12+, Apple CarPlay, Android Auto.

## Glossary

- **App**: The CONVOY mobile application running on iOS or Android.
- **CarPlay_Interface**: The Apple CarPlay UI surface rendered by the App on a vehicle head unit.
- **Auto_Interface**: The Android Auto UI surface rendered by the App on a vehicle head unit.
- **Auth_Service**: The authentication subsystem responsible for identity management and session tokens.
- **Location_Service**: The on-device subsystem that reads GPS coordinates and heading data.
- **Map_View**: The primary map rendering component backed by the Mapbox SDK.
- **Router**: The subsystem that calculates and manages navigation routes.
- **Convoy_Group**: A named driving group with one Admin and one or more Members sharing a session.
- **Admin**: The authenticated user who created or inherited leadership of a Convoy_Group.
- **Member**: An authenticated user who has joined a Convoy_Group.
- **Guest**: An unauthenticated user with read-only access to the local map.
- **PTT_Service**: The push-to-talk audio subsystem (Agora.io or LiveKit).
- **Hazard_Service**: The subsystem that manages creation, confirmation, expiry, and dismissal of road hazards.
- **Hazard_Report**: A crowd-sourced road condition record with type, location, timestamp, and lifecycle state.
- **Offline_Cache**: The local SQLite store and Mapbox tile cache used during connectivity loss.
- **Sync_Service**: The subsystem that queues offline changes and applies them when connectivity is restored.
- **Notification_Service**: The subsystem responsible for push and in-app notifications via FCM and APNs.
- **OTP**: One-time password delivered by SMS for phone number authentication.
- **Drive_History**: A persistent log of completed Convoy_Group sessions saved to a user's profile, containing route trace, distance, duration, speed stats, and member count.
- **Rally_Point**: A destination pin broadcast by any Member to the Convoy_Group that each Member routes to independently.
- **Driving_Mode**: A stripped-down UI layout activated on the phone screen during vehicle Bluetooth or CarPlay connection, showing only essential controls.
- **Garage**: A collection of vehicle profiles associated with a user's account, one of which is designated as active.
- **PTT_Channel**: A named sub-channel within a Convoy_Group that scopes PTT transmissions to a subset of Members.
- **PTT_Log**: An ephemeral in-session record of PTT transmission events (sender identity and timestamp), visible to all Members and cleared when the session ends.
- **Motion_State**: The detected movement state of the device, derived from GPS speed. The App considers the device in motion when GPS speed exceeds 5 mph and parked otherwise.
- **Privacy_Policy**: The document describing the App's data collection and processing practices, accessible from the unauthenticated onboarding screen and from Settings > Account.
- **Data_Export**: A machine-readable JSON file containing all user-owned data (profile, drive history, friends list), generated on demand in compliance with GDPR Article 20.

---

## Requirements

### Requirement 1: Guest Map Access

**User Story:** As a Guest, I want to view the map around my current location, so that I can explore the app before creating an account.

#### Acceptance Criteria

1. THE Map_View SHALL display the current device location using a directional heading pin.
2. THE Map_View SHALL support pinch-to-zoom, double-tap zoom, and free panning.
3. THE Map_View SHALL provide a re-center button that returns the viewport to the current location.
4. THE Map_View SHALL offer Standard, Satellite, and Hybrid style options.
5. THE Map_View SHALL follow the device system setting for Dark and Light mode.
6. WHILE a user is unauthenticated, THE App SHALL restrict access to group creation, group joining, hazard reporting, and PTT features.

---

### Requirement 2: Authentication

**User Story:** As a new user, I want to sign in using my phone number, email, Apple account, or Google account, so that I can access all app features securely.

#### Acceptance Criteria

1. THE Auth_Service SHALL support phone number authentication via SMS OTP.
2. THE Auth_Service SHALL support email address and password authentication.
3. THE Auth_Service SHALL support Sign in with Apple.
4. THE Auth_Service SHALL support Sign in with Google.
5. WHEN a user submits a phone number, THE Auth_Service SHALL send an OTP to that number within 30 seconds.
6. WHEN an OTP is submitted, THE Auth_Service SHALL validate it and issue a session token within 5 seconds.
7. IF an OTP expires or is invalid, THEN THE Auth_Service SHALL return a descriptive error and allow the user to request a new OTP.
8. IF authentication fails, THEN THE Auth_Service SHALL return an error message without revealing which credential component is incorrect.

---

### Requirement 3: User Profile

**User Story:** As an authenticated user, I want to manage my profile and privacy settings, so that I can personalise my experience and control who can find me.

#### Acceptance Criteria

1. THE App SHALL allow an authenticated user to set a display name and optional avatar photo.
2. THE App SHALL allow an authenticated user to enter optional vehicle information: year, make, model, and color.
3. THE App SHALL allow an authenticated user to set a PTT callsign used to identify the user during voice sessions.
4. THE App SHALL allow an authenticated user to set a privacy setting of either "allow friend requests from anyone" or "invite only".

---

### Requirement 4: Map Tile Caching

**User Story:** As a driver, I want map tiles cached along my route, so that I can navigate reliably in areas with poor cellular coverage.

#### Acceptance Criteria

1. WHEN an active route is set, THE Offline_Cache SHALL prefetch map tiles covering the route corridor plus a 10-mile buffer.
2. THE Offline_Cache SHALL limit the total map tile storage to 500 MB.
3. WHILE the device has no network connectivity, THE Map_View SHALL render using cached tiles.
4. IF the required tiles are not cached, THEN THE Map_View SHALL display a visual indicator that map data is unavailable for that area.

---

### Requirement 5: Pin Drop and Directions

**User Story:** As a driver, I want to drop a pin on the map and get directions to it, so that I can navigate to any point of interest.

#### Acceptance Criteria

1. WHEN a user long-presses on the map, THE Map_View SHALL place a pin at that location.
2. WHEN a pin is tapped, THE App SHALL display the reverse-geocoded address for that pin's coordinates.
3. WHEN a user selects "Get Directions" from a pin, THE Router SHALL calculate a route to that pin.
4. THE App SHALL store dropped pins locally on the device only and SHALL NOT transmit pin data to any server.

---

### Requirement 6: Routing and Traffic

**User Story:** As a driver, I want traffic-aware routing with multiple route options and waypoint support, so that I can choose the best path and adjust mid-trip.

#### Acceptance Criteria

1. WHEN a destination is set, THE Router SHALL calculate up to 3 alternate routes.
2. THE Map_View SHALL display a traffic overlay using green, yellow, red, and dark red color coding to indicate traffic severity.
3. THE Router SHALL refresh traffic data every 60 seconds while a route is active.
4. THE Router SHALL support up to 10 waypoints per route with drag-and-drop reordering.
5. WHEN a route is active, THE Router SHALL allow a user to add a waypoint mid-trip without cancelling the route.
6. WHILE the device has no network connectivity, THE Router SHALL continue to display the last-calculated route using cached data.

---

### Requirement 7: Convoy Group Creation and Management

**User Story:** As a car enthusiast, I want to create and manage a driving group, so that my crew can navigate together and see each other on the map.

#### Acceptance Criteria

1. WHEN an authenticated user creates a Convoy_Group, THE App SHALL assign that user the Admin role.
2. WHEN a Convoy_Group is created, THE App SHALL generate a unique 6-character alphanumeric join code.
3. THE App SHALL allow the Admin to share the join code via the system share sheet or as a QR code.
4. THE App SHALL allow authenticated users to join a Convoy_Group by entering the join code or following a deep link.
5. THE App SHALL support both open groups (anyone with the code can join) and invite-only groups.
6. WHEN a Member joins a Convoy_Group, THE App SHALL display a toast notification to existing Members.
7. WHEN a Member leaves a Convoy_Group, THE App SHALL display a toast notification to remaining Members.
8. WHEN the Admin leaves a Convoy_Group, THE App SHALL transfer the Admin role to the next Member in the member list.
9. WHEN the Admin ends the Convoy_Group, THE App SHALL notify all Members and terminate the session.

---

### Requirement 8: Real-Time Member Location Sharing

**User Story:** As a group member, I want to see all convoy members on the map with their live positions, so that I can stay aware of the group's spread.

#### Acceptance Criteria

1. WHILE a user is a Member of an active Convoy_Group, THE Location_Service SHALL transmit the user's GPS coordinates, heading, and speed to the server every 3 seconds.
2. WHILE a user is a Member of an active Convoy_Group, THE Map_View SHALL update each Member's pin position at least every 3 seconds.
3. THE Map_View SHALL display each Member's pin with a directional heading indicator.
4. THE App SHALL display a Member list panel showing each Member's status, current speed, and estimated distance from the Admin's position.
5. THE App SHALL display a synchronized ETA for all Members based on the shared route.
6. WHILE the device has no network connectivity, THE Map_View SHALL display each Member's last-known position with the timestamp of the last update.

---

### Requirement 9: Shared Route Push

**User Story:** As a group Admin, I want to push a shared route to all group members, so that everyone navigates the same path.

#### Acceptance Criteria

1. WHEN the Admin sets a route, THE App SHALL offer the Admin the option to push that route to all Members.
2. WHEN the Admin pushes a route, THE Router SHALL apply the route on all Member devices within 5 seconds.
3. WHEN a shared route is received, THE App SHALL notify each Member that a new route has been set by the Admin.

---

### Requirement 10: Push-to-Talk (PTT) Communication

**User Story:** As a driver, I want to use push-to-talk voice communication within my convoy, so that I can communicate hands-free without using a phone call.

#### Acceptance Criteria

1. THE PTT_Service SHALL restrict PTT sessions to the active Convoy_Group.
2. WHEN a Member holds the PTT button, THE PTT_Service SHALL begin transmitting the microphone audio to the group.
3. WHEN a Member releases the PTT button, THE PTT_Service SHALL end the transmission.
4. THE App SHALL display a visual indicator identifying the Member currently transmitting.
5. THE PTT_Service SHALL enforce a maximum transmission duration of 30 seconds by default.
6. WHERE the Admin has configured a custom limit, THE PTT_Service SHALL enforce a maximum transmission duration of up to 60 seconds.
7. THE PTT_Service SHALL NOT record or persist transmitted audio.
8. THE App SHALL provide a separate PTT volume slider independent of the device media volume.
9. WHEN PTT audio is active, THE App SHALL apply media ducking to reduce the volume of any playing music or media.
10. THE App SHALL allow a Member to mute themselves, preventing the PTT button from transmitting audio.
11. THE App SHALL allow the Admin to mute any individual Member or all Members simultaneously.
12. THE App SHALL allow any Member to locally mute another Member's incoming audio.
13. THE CarPlay_Interface SHALL expose a PTT button accessible while driving.

---

### Requirement 11: Road Hazard Reporting

**User Story:** As a driver, I want to report and see road hazards reported by other convoy members, so that I can drive more safely.

#### Acceptance Criteria

1. THE App SHALL display a persistent "Report" button visible on the main map screen at all times when authenticated.
2. WHEN the "Report" button is tapped, THE App SHALL present a quick-select grid of hazard types: Police/Speed Trap, Road Hazard, Vehicle Breakdown, Accident/Crash, Road Closure, Speed Camera, Construction Zone, Weather Hazard, and Custom/Other.
3. WHEN a Hazard_Report is submitted, THE Hazard_Service SHALL assign an expiry time of 30 minutes from the submission timestamp.
4. THE Map_View SHALL display active Hazard_Report icons showing hazard type, distance from the user, and report age.
5. WHEN another authenticated user confirms a Hazard_Report, THE Hazard_Service SHALL reset the expiry timer to 30 minutes from the confirmation timestamp.
6. WHEN a Hazard_Report has received 3 or more dismissals, THE Hazard_Service SHALL remove the hazard from the map.
7. WHEN the user is within 0.5 miles of an active Hazard_Report, THE Notification_Service SHALL deliver an approaching hazard alert.
8. WHERE the user has configured a custom alert distance, THE Notification_Service SHALL use that distance instead of the default 0.5 miles.
9. WHILE the device has no network connectivity, THE App SHALL queue Hazard_Report submissions in the Offline_Cache.
10. WHEN network connectivity is restored, THE Sync_Service SHALL transmit all queued Hazard_Reports to the server within 15 minutes.

---

### Requirement 12: Hazard Report Round-Trip Integrity

**User Story:** As a developer, I want hazard report data to survive serialization and deserialization intact, so that reports are never silently corrupted in transit or storage.

#### Acceptance Criteria

1. THE Hazard_Service SHALL serialize each Hazard_Report to a JSON representation.
2. WHEN a serialized Hazard_Report is deserialized, THE Hazard_Service SHALL produce a Hazard_Report object equivalent to the original.
3. FOR ALL valid Hazard_Report objects, serializing then deserializing then re-serializing SHALL produce an output identical to the first serialization (round-trip property).

---

### Requirement 13: Apple CarPlay and Android Auto Support

**User Story:** As a driver, I want to use core CONVOY features on my vehicle's head unit display, so that I can keep my phone out of my hands while driving.

#### Acceptance Criteria

1. THE CarPlay_Interface SHALL display the Map_View with active route and Member pins.
2. THE CarPlay_Interface SHALL expose a PTT button.
3. THE CarPlay_Interface SHALL expose a hazard report shortcut.
4. THE CarPlay_Interface SHALL display the Member status list.
5. THE CarPlay_Interface SHALL provide a volume control and self-mute toggle.
6. THE Auto_Interface SHALL provide the equivalent features to the CarPlay_Interface using Android Auto template APIs.
7. WHEN the user connects or disconnects a CarPlay or Android Auto session, THE App SHALL seamlessly transfer the active session state between the phone and head unit without interrupting navigation or PTT.

---

### Requirement 14: Offline and Low-Signal Resilience

**User Story:** As a driver in a remote area, I want the app to remain functional when I lose signal, so that I am not left without navigation or group awareness.

#### Acceptance Criteria

1. WHILE the device has no network connectivity, THE App SHALL display a low-signal warning indicator.
2. WHILE the device has no network connectivity, THE Map_View SHALL render the cached route.
3. WHILE the device has no network connectivity, THE Map_View SHALL display the last-known position of each group Member with the time elapsed since the last update.
4. WHEN network connectivity is restored, THE Sync_Service SHALL perform a full sync of location, hazard, and group state data.
5. WHEN PTT signal quality degrades, THE App SHALL display a signal quality indicator on the PTT button.

---

### Requirement 15: Notifications and Alerts

**User Story:** As a user, I want timely notifications about hazards, group events, and navigation milestones, so that I stay informed without needing to look at the screen.

#### Acceptance Criteria

1. WHEN the user is approaching an active Hazard_Report, THE Notification_Service SHALL deliver both a push notification and an in-app banner.
2. WHEN a user receives a Convoy_Group invite, THE Notification_Service SHALL deliver a push notification.
3. WHEN the user's device is approaching the destination, THE Notification_Service SHALL deliver an arriving-at-destination alert.
4. WHEN an Admin performs a group action (route push, member mute, group end), THE Notification_Service SHALL deliver an in-app notification to affected Members.
5. THE App SHALL allow users to configure notification preferences per category in the Settings screen.

---

### Requirement 16: User Settings

**User Story:** As a user, I want a settings screen covering all app behaviour, so that I can tailor the app to my preferences.

#### Acceptance Criteria

1. THE App SHALL provide settings sections for: Profile, Privacy, Map, Navigation, Audio, Offline, CarPlay, Notifications, and Account.
2. THE App SHALL allow the user to configure the approaching hazard alert distance threshold.
3. THE App SHALL allow the user to configure PTT maximum transmission duration (Admin only, up to 60 seconds).
4. THE App SHALL allow the user to configure the maximum Offline_Cache storage size up to 500 MB.
5. THE App SHALL allow the user to toggle map style between Standard, Satellite, and Hybrid.

---

### Requirement 17: Friend System

**User Story:** As an authenticated user, I want to add friends using an invite link, QR code, or phone number search, so that I can quickly connect with people I know and share my location with them.

#### Acceptance Criteria

1. THE App SHALL allow an authenticated user to generate a shareable invite link that encodes the user's identity as a deep link.
2. THE App SHALL allow an authenticated user to generate a QR code that encodes the same invite deep link.
3. WHEN another authenticated user opens the invite link or scans the QR code, THE App SHALL initiate a friend request from that user to the link owner.
4. THE App SHALL allow an authenticated user to search for other users by phone number.
5. WHEN a phone number search returns a result, THE App SHALL allow the searching user to send a friend request to the matched user.
6. WHILE a user's privacy setting is "allow friend requests from anyone", THE App SHALL auto-accept incoming friend requests and add the sender to the user's friend list immediately.
7. WHILE a user's privacy setting is "invite only", THE App SHALL queue incoming friend requests for manual review and notify the user via the Notification_Service.
8. WHEN a user approves a pending friend request, THE App SHALL add both users to each other's friend list and notify the requester via the Notification_Service.
9. WHEN a user declines a pending friend request, THE App SHALL remove the request from the queue and SHALL NOT notify the requester of the rejection.
10. THE App SHALL allow a user to remove an existing friend, which SHALL remove the friendship from both users' friend lists immediately.
11. THE App SHALL allow a user to block another user, which SHALL prevent that user from sending further friend requests or viewing the blocking user's location.

---

### Requirement 18: Destination Search

**User Story:** As a driver, I want to search for places, businesses, and addresses when setting a navigation destination, so that I can navigate to any location without needing to drop a pin manually.

#### Acceptance Criteria

1. THE App SHALL provide a destination search input on the navigation screen that accepts free-text queries.
2. WHEN a user enters a search query of 3 or more characters, THE App SHALL query a places and geocoding API (Google Places API, Apple MapKit JS Places API, or Mapbox Geocoding API) and display results within 2 seconds.
3. THE App SHALL display each search result with the business or place name, street address, and place category or POI type where available.
4. WHEN a user selects a search result, THE Router SHALL set that result's coordinates as the navigation destination and calculate a route.
5. THE App SHALL display a minimum of 5 and a maximum of 10 search results per query.
6. IF the places API returns no results for a query, THEN THE App SHALL display a "No results found" message and allow the user to refine the search.
7. IF the places API request fails or times out, THEN THE App SHALL display a descriptive error message and allow the user to retry.
8. WHILE the device has no network connectivity, THE App SHALL disable the destination search input and display a message indicating that search requires a network connection.
9. THE App SHALL NOT transmit the raw search query to any server other than the configured places and geocoding API provider.

---

### Requirement 19: Post-Convoy Summary and Drive Stats

**User Story:** As a Member, I want to see a summary of the drive after a Convoy_Group session ends, so that I can review my trip stats and share them with others.

#### Acceptance Criteria

1. WHEN a Convoy_Group session ends, THE App SHALL generate a Drive_History record for each Member containing: route map trace, total distance, total duration, average speed, top speed, and Member count.
2. THE App SHALL save each Drive_History record to the user's profile on the server.
3. THE App SHALL provide a "Drive History" screen in the user's profile where all saved Drive_History records are browsable in reverse chronological order.
4. WHEN a user views a Drive_History record, THE App SHALL display the route trace on the Map_View alongside the recorded stats.
5. THE App SHALL allow a user to generate a shareable summary card image from any Drive_History record, containing the route map, key stats, and the CONVOY app branding.
6. WHEN a user exports a summary card, THE App SHALL save the card as an image to the device photo library or trigger the system share sheet.
7. IF a Member has no network connectivity when the session ends, THEN THE Sync_Service SHALL queue the Drive_History record and upload it when connectivity is restored.

---

### Requirement 20: Meet Me Here Rally Point

**User Story:** As a Member, I want to broadcast a destination pin to the whole group, so that everyone can independently route to the same meeting point.

#### Acceptance Criteria

1. WHEN any authenticated Member long-presses on the map, THE App SHALL present an option to broadcast a Rally_Point to the Convoy_Group.
2. WHEN a Rally_Point is broadcast, THE App SHALL deliver an alert to all group Members containing the pin location and reverse-geocoded address within 5 seconds.
3. THE Map_View SHALL display the active Rally_Point on all group Members' maps using a distinct Rally_Point icon, separate from standard dropped pins.
4. WHEN a Member taps the Rally_Point alert, THE Router SHALL calculate an independent route from that Member's current location to the Rally_Point.
5. THE App SHALL allow any Member who broadcast a Rally_Point to cancel it, which SHALL remove the Rally_Point icon from all Members' maps.
6. IF a Member has no active Convoy_Group, THEN THE App SHALL disable the Rally_Point broadcast option.

---

### Requirement 21: Fuel Stop Suggestions

**User Story:** As a convoy participant, I want the app to suggest fuel stops when a refuel may be needed, so that the group can plan a break before running low.

#### Acceptance Criteria

1. WHEN a Convoy_Group has been in an active session for 150 miles or 2 hours of continuous travel, whichever occurs first, THE App SHALL display a fuel stop suggestion banner to the Admin.
2. WHEN the Admin taps the fuel stop suggestion banner, THE App SHALL display a list of nearby fuel stations sourced from the configured places API, sorted by distance from the Admin's current location.
3. WHEN the Admin selects a fuel station from the list, THE Router SHALL broadcast that station as a group waypoint to all Members.
4. THE App SHALL provide a "Find fuel nearby" option accessible to all Members at any time during an active session, which queries the places API for fuel stations near the Member's current location.
5. IF the places API returns no fuel stations within 10 miles, THEN THE App SHALL display a "No fuel stations found nearby" message to the requesting user.

---

### Requirement 22: Scenic Route Mode

**User Story:** As a driver, I want to opt into a scenic routing preference, so that I can prioritise enjoyable roads over the fastest route.

#### Acceptance Criteria

1. THE App SHALL display a "Scenic" route preference toggle on the route calculation screen.
2. WHEN the "Scenic" toggle is active and the user requests a route, THE Router SHALL request a scenic or avoid-highways routing variant from the mapping provider.
3. WHEN the mapping provider returns a scenic route variant, THE Router SHALL present that route as the default selection, with standard routes available as alternates.
4. IF the mapping provider does not support a scenic routing variant for the requested journey, THEN THE Router SHALL notify the user that scenic routing is unavailable for that route and fall back to standard routing.
5. THE App SHALL persist the user's scenic routing preference between sessions until the user changes it.

---

### Requirement 23: Speed Limit Overlay

**User Story:** As a driver, I want to see the current road's posted speed limit on the map, so that I can stay aware of the legal limit without taking my eyes off the road.

#### Acceptance Criteria

1. WHILE navigation is active, THE Map_View SHALL display the posted speed limit for the current road segment in a persistent HUD element.
2. WHEN the user moves onto a road segment with a different posted speed limit, THE Map_View SHALL update the speed limit display within 3 seconds.
3. WHEN the user's current speed exceeds the posted speed limit for the current road segment, THE Map_View SHALL visually highlight the speed limit indicator.
4. IF the mapping provider does not supply speed limit data for the current road segment, THEN THE Map_View SHALL display a dash or "–" in place of a numeric speed limit.

---

### Requirement 24: Convoy Gap Alert

**User Story:** As a convoy Admin, I want to be alerted when a Member falls significantly behind the group, so that I can take action without that Member being distracted.

#### Acceptance Criteria

1. WHILE an active Convoy_Group session is in progress, THE App SHALL monitor the distance between each Member's current location and the lead vehicle's current location.
2. WHEN a Member's distance behind the lead vehicle exceeds the configured gap threshold, THE App SHALL deliver a quiet in-app alert to the Admin only, identifying the Member by name and stating their distance behind.
3. THE App SHALL set the default gap alert threshold to 2 miles.
4. THE App SHALL allow the Admin to configure the gap alert threshold in the group settings.
5. THE App SHALL NOT deliver a gap alert to the Member who has fallen behind.
6. IF a Member's location data has not been updated for more than 30 seconds, THEN THE App SHALL exclude that Member from gap calculations until a fresh location update is received.

---

### Requirement 25: Emergency SOS Pin

**User Story:** As a Member, I want to broadcast an emergency pin to the whole group, so that other Members know my exact location in an emergency.

#### Acceptance Criteria

1. THE App SHALL display a clearly accessible SOS button on the main map screen at all times for authenticated Members.
2. WHEN a Member taps the SOS button, THE App SHALL display a confirmation prompt before broadcasting.
3. WHEN the Member confirms the SOS action, THE App SHALL immediately broadcast the Member's exact GPS coordinates to all group Members as a high-priority alert.
4. THE Map_View SHALL display the SOS pin on all group Members' maps using a distinct emergency icon, visually differentiated from all other pin types.
5. WHEN an SOS pin is received, THE Notification_Service SHALL deliver a high-priority alert to all group Members identifying the transmitting Member by name.
6. THE App SHALL allow the Member who triggered the SOS pin to cancel it, which SHALL remove the SOS icon from all Members' maps and deliver a cancellation notice.
7. IF a Member has no active Convoy_Group, THEN THE App SHALL still allow the SOS pin to be broadcast to any friends who have location sharing active with that Member.

---

### Requirement 26: Named PTT Sub-Channels

**User Story:** As a convoy Admin, I want to create named PTT sub-channels within the group, so that subsets of Members can communicate independently.

#### Acceptance Criteria

1. THE App SHALL allow the Admin to create named PTT_Channels within an active Convoy_Group.
2. THE App SHALL ensure an "All" PTT_Channel always exists in every Convoy_Group and cannot be deleted by the Admin.
3. WHEN the Admin creates a PTT_Channel, THE App SHALL allow the Admin to assign Members to that channel.
4. WHEN a Member selects a PTT_Channel, THE PTT_Service SHALL scope that Member's PTT transmissions to recipients in the same PTT_Channel only.
5. WHEN a PTT transmission is made on the "All" PTT_Channel, THE PTT_Service SHALL deliver that transmission to all Members of the Convoy_Group regardless of their assigned PTT_Channel.
6. THE App SHALL restrict each Member to membership in exactly one PTT_Channel at a time.
7. THE App SHALL allow a Member to switch their active PTT_Channel from the PTT controls panel.

---

### Requirement 27: PTT Transmission Log

**User Story:** As a group Member, I want to see a log of who transmitted via PTT and when, so that I can review communications during the session.

#### Acceptance Criteria

1. WHILE an active Convoy_Group session is in progress, THE App SHALL maintain a PTT_Log recording the transmitting Member's display name and the UTC timestamp of each PTT transmission start event.
2. THE PTT_Log SHALL be visible to all Members in the Member List panel during the active session.
3. THE PTT_Service SHALL NOT store or log the audio content of any transmission.
4. WHEN the Convoy_Group session ends, THE App SHALL clear the PTT_Log from all Member devices.
5. THE App SHALL display PTT_Log entries in chronological order with the most recent entry at the bottom.

---

### Requirement 28: Minimalist Driving Mode

**User Story:** As a driver, I want the app to switch to a simplified interface on my phone when connected to my vehicle, so that I have fewer distractions while driving.

#### Acceptance Criteria

1. WHEN the device establishes a Bluetooth connection to a vehicle or initiates a CarPlay session, THE App SHALL automatically activate Driving_Mode on the phone screen.
2. WHILE Driving_Mode is active, THE App SHALL display only the Map_View, PTT button, hazard report button, and a minimal status bar.
3. WHILE Driving_Mode is active, THE App SHALL hide all other UI panels, settings, menus, and secondary controls.
4. THE App SHALL allow a user to manually activate Driving_Mode at any time from the main screen.
5. THE App SHALL allow a user to manually deactivate Driving_Mode at any time by tapping a clearly labelled exit control.
6. WHEN the device Bluetooth connection to the vehicle is disconnected and no CarPlay session is active, THE App SHALL automatically deactivate Driving_Mode.

---

### Requirement 29: Garage — Multiple Vehicle Profiles

**User Story:** As a user with multiple vehicles, I want to manage a Garage of vehicle profiles and select which one I am currently driving, so that other Members see accurate vehicle information on my pin.

#### Acceptance Criteria

1. THE App SHALL allow an authenticated user to add multiple vehicle profiles to their Garage, each containing: year, make, model, colour, and an optional photo.
2. THE App SHALL allow a user to designate one vehicle in their Garage as the active vehicle.
3. THE App SHALL allow a user to add, edit, and delete vehicle profiles from the Garage in the profile settings screen.
4. WHEN another Member taps a friend's pin on the Map_View, THE App SHALL display the friend's active vehicle details — year, make, model, and colour — in the pin info card.
5. WHERE the active vehicle has a photo, THE App SHALL display the vehicle photo in the pin info card.
6. IF a user has no vehicle in their Garage, THEN THE App SHALL display "No vehicle set" in place of vehicle details on the pin info card.

---

### Requirement 30: Driver Distraction — Motion State Detection

**User Story:** As a driver, I want the app to detect when I am moving so that distracting interactions are automatically suppressed while driving.

#### Acceptance Criteria

1. THE App SHALL derive Motion_State from the device GPS speed reading, not from accelerometer data.
2. WHEN GPS speed exceeds 5 mph, THE App SHALL set Motion_State to "in motion".
3. WHEN GPS speed is 5 mph or below, THE App SHALL set Motion_State to "parked".
4. WHILE Motion_State is "in motion", THE App SHALL suppress or simplify interactions as required by Requirements 31 through 34.

---

### Requirement 31: Driver Distraction — Hazard Type Picker (Phone)

**User Story:** As a driver using the phone screen while in motion, I want a simplified hazard picker so that I can report hazards safely with minimal visual attention.

#### Acceptance Criteria

1. WHILE Motion_State is "in motion", THE App SHALL display no more than 6 large touch targets on the hazard type picker on the phone screen.
2. WHILE Motion_State is "parked", THE App SHALL display the full 9-type hazard grid on the hazard type picker.
3. THE CarPlay_Interface SHALL always display the hazard type picker using the CPGridTemplate and SHALL NOT apply the in-motion 6-target restriction to the head unit display.

---

### Requirement 32: Driver Distraction — Destination Search Input

**User Story:** As a driver in motion, I want destination input restricted to voice or recent destinations so that I am not tempted to type while driving.

#### Acceptance Criteria

1. WHILE Motion_State is "in motion", THE App SHALL suppress the free-text destination search input field.
2. WHILE Motion_State is "in motion", THE App SHALL allow destination selection via platform voice search (iOS Speech framework or Android SpeechRecognizer) or from the recently used destinations list.
3. WHILE Motion_State is "parked", THE App SHALL restore the full free-text destination search input.

---

### Requirement 33: Driver Distraction — Scrollable List Limit

**User Story:** As a driver in motion, I want scrollable lists limited in height so that I am not required to scroll through long lists while the vehicle is moving.

#### Acceptance Criteria

1. WHILE Motion_State is "in motion", THE App SHALL limit any scrollable list displayed on the phone screen to showing 4 items at a time without requiring scrolling.

---

### Requirement 34: Driver Distraction — Multi-Step Flow Blocking

**User Story:** As a driver in motion, I want multi-step flows blocked so that I am not led through complex interactions while the vehicle is moving.

#### Acceptance Criteria

1. WHILE Motion_State is "in motion", THE App SHALL block initiation of multi-step flows including adding a waypoint, editing group settings, managing PTT_Channels, and any flow requiring more than one decision step.
2. WHEN a user attempts to initiate a blocked multi-step flow while Motion_State is "in motion", THE App SHALL display a "Park to continue" prompt.

---

### Requirement 35: Driver Distraction — CarPlay and Android Auto Template Compliance

**User Story:** As a developer, I want the CarPlay and Android Auto interfaces to use only platform-approved template types so that the app passes Apple and Google certification.

#### Acceptance Criteria

1. THE CarPlay_Interface SHALL use only Apple-approved CPTemplate types: CPMapTemplate, CPGridTemplate, CPListTemplate, and CPAlertTemplate.
2. THE CarPlay_Interface SHALL NOT attempt to render custom UI overlays or views outside the CPTemplate system.
3. THE Auto_Interface SHALL use only AndroidX Car App Library template types.
4. THE Auto_Interface SHALL NOT attempt custom canvas drawing outside the AndroidX Car App Library rendering model.

---

### Requirement 36: App Store and Play Store Compliance

**User Story:** As a product owner, I want the app to satisfy Apple App Store and Google Play Store review requirements so that it is not rejected or removed from distribution.

#### Acceptance Criteria

1. THE App SHALL offer Sign in with Apple on every screen where any third-party authentication method (Google sign-in or phone OTP) is offered.
2. THE App SHALL display a link to the Privacy_Policy and a link to the Terms of Service URL on the unauthenticated onboarding screen and within Settings > Account.
3. THE App SHALL provide a clearly labelled "Delete Account" action within Settings > Account that initiates a hard-delete of all user data — location history, reports, group memberships, drive history, vehicles, and friends — within 30 days of request confirmation.
4. THE App SHALL NOT request "Always On" location permission on first launch. THE App SHALL request "While Using" location permission on first launch.
5. WHEN the user first joins or creates a Convoy_Group, THE App SHALL request "Always On" location permission with a clear explanation of why background location is needed for the group session.
6. THE App SHALL request microphone permission only when the user first attempts to use the PTT feature, accompanied by a usage description explaining PTT functionality.
7. THE App SHALL request push notification permission after the user completes onboarding, not on first launch.
8. THE App SHALL include a background location mode declaration in the iOS Info.plist accompanied by a user-facing explanation of background location usage.

---

### Requirement 37: Server-Side Rate Limiting

**User Story:** As an operator, I want server-side rate limits on sensitive endpoints so that abusive or accidental high-frequency usage is automatically controlled.

#### Acceptance Criteria

1. THE Hazard_Service SHALL enforce a rate limit of 10 hazard report submissions per user per hour. IF a user exceeds this limit, THEN THE Hazard_Service SHALL return an HTTP 429 response with a descriptive error.
2. THE Auth_Service SHALL enforce a rate limit of 5 OTP requests per phone number per 10 minutes. IF a phone number exceeds this limit, THEN THE Auth_Service SHALL return an HTTP 429 response.
3. THE App SHALL enforce a rate limit of 20 friend requests per user per hour on the friend request endpoint. IF a user exceeds this limit, THEN THE App SHALL return an HTTP 429 response.
4. THE App SHALL enforce a rate limit of 10 Convoy_Group join attempts per user per hour to prevent join-code brute-forcing. IF a user exceeds this limit, THEN THE App SHALL return an HTTP 429 response.
5. THE App SHALL enforce a cooldown of 60 seconds between consecutive SOS broadcasts from the same user. IF a user attempts a second SOS broadcast within the cooldown window, THEN THE App SHALL return an HTTP 429 response.

---

### Requirement 38: Session and Token Security

**User Story:** As a security-conscious user, I want session tokens and join codes to expire appropriately so that stale credentials cannot be reused.

#### Acceptance Criteria

1. WHEN a Convoy_Group has been inactive for 24 hours or the group session ends — whichever occurs first — THE App SHALL expire the group join code so that it can no longer be used to join the group.
2. THE PTT_Service SHALL issue PTT tokens with a maximum TTL of 4 hours.
3. WHEN a PTT token is approaching expiry, THE App SHALL automatically request a refreshed token before the current token expires, without interrupting an active PTT session.
4. THE App SHALL store all authentication tokens in platform secure storage: iOS Keychain via expo-secure-store and Android Keystore.
5. THE App SHALL NOT store authentication tokens in AsyncStorage or any other non-secure storage mechanism.

---

### Requirement 39: Accessibility — Touch Targets and Haptics

**User Story:** As a user with motor or sensory impairments, I want interactive elements to be large enough to tap and to provide non-visual feedback so that the app is usable regardless of ability.

#### Acceptance Criteria

1. THE App SHALL ensure all interactive elements have a minimum touch target size of 44×44 points.
2. WHEN the PTT visual transmission indicator activates, THE App SHALL simultaneously trigger haptic feedback to notify deaf or hard-of-hearing users that a transmission is in progress.

---

### Requirement 40: Accessibility — SOS Button Contrast and Visibility

**User Story:** As a user in any lighting condition or display mode, I want the SOS button to remain visually distinct so that it is always easy to identify in an emergency.

#### Acceptance Criteria

1. THE App SHALL render the SOS button with high-contrast styling that meets WCAG AA contrast ratios in both light mode and dark mode.
2. WHILE the device is in dark mode, THE App SHALL preserve the SOS button's visual distinction and SHALL NOT reduce its contrast relative to the surrounding UI.

---

### Requirement 41: Accessibility — Dynamic Type and Font Scaling

**User Story:** As a user who relies on larger text sizes, I want non-map text to scale with my system font size so that the app remains readable at my preferred size.

#### Acceptance Criteria

1. THE App SHALL support Dynamic Type on iOS for all non-map text elements, scaling text in response to the system accessibility font size setting.
2. THE App SHALL support Android font scaling for all non-map text elements, scaling text in response to the system display size and font size settings.
3. THE App SHALL NOT fix the font size of non-map UI text elements to prevent scaling.

---

### Requirement 42: Data Retention and Privacy

**User Story:** As a privacy-conscious user, I want my location and personal data handled with minimal retention so that my movements are not permanently stored without my consent.

#### Acceptance Criteria

1. WHEN a Member's location update is received by the server during a Convoy_Group session, THE App SHALL store that location data in the ephemeral Redis presence store only and SHALL NOT write it to the long-term database.
2. Location data in the Redis presence store SHALL be discarded no later than 5 minutes after the last update for a given Member.
3. THE App SHALL allow a user to delete any individual Drive_History record from their profile, permanently removing the record and its associated route trace from the server.
4. THE App SHALL provide a Data_Export function allowing an authenticated user to download all their stored data — profile, drive history, and friends list — as a JSON file, accessible from Settings > Account.

---

### Requirement 43: Network and Error Resilience

**User Story:** As a driver in areas with intermittent connectivity, I want the app to retry failed requests gracefully and surface service availability clearly so that transient network issues do not silently degrade the experience.

#### Acceptance Criteria

1. THE App SHALL implement a retry policy of up to 3 attempts with exponential backoff for all REST API calls that receive 5xx responses or network timeout errors.
2. THE App SHALL implement WebSocket reconnection with exponential backoff, starting at 1 second and capping at 30 seconds, with random jitter applied to each reconnection interval.
3. IF the PTT_Service (Agora or LiveKit) is unreachable, THEN THE App SHALL display a "Voice unavailable" indicator on the PTT button and disable the PTT button rather than silently failing.
