import { Linking, Platform } from 'react-native';

/**
 * Opens the platform's native Maps app with turn-by-turn directions to
 * (lat, lon). iOS prefers Apple Maps (falls back to Google Maps if not
 * installed/supported); Android always uses the Google Maps web URL, which
 * the OS resolves to the Google Maps app when installed.
 *
 * Extracted from FuelStopSheet's "Get Directions" action (fuel station
 * navigation) so other screens — e.g. IdleMapScreen's friend-SOS pin — can
 * reuse the same external-navigation behavior instead of reimplementing it.
 */
export function openMapsDirections(lat: number, lon: number, name: string): void {
  const encodedName = encodeURIComponent(name);
  const appleUrl = `maps://maps.apple.com/?daddr=${lat},${lon}&q=${encodedName}`;
  const googleUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&destination_place_id=${encodedName}`;

  if (Platform.OS === 'ios') {
    Linking.canOpenURL(appleUrl)
      .then((supported) =>
        Linking.openURL(supported ? appleUrl : googleUrl),
      )
      .catch(() => Linking.openURL(googleUrl));
  } else {
    Linking.openURL(googleUrl).catch(() => {/* no-op */});
  }
}
