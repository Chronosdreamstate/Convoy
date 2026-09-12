import { Linking, Platform } from 'react-native';

/**
 * Opens the platform's native Maps app with turn-by-turn directions to
 * (lat, lon). iOS prefers Apple Maps (falls back to Google Maps if not
 * installed/supported); Android always uses the Google Maps web URL, which
 * the OS resolves to the Google Maps app when installed.
 *
 * Shared external-navigation helper — e.g. IdleMapScreen's friend-SOS pin —
 * so screens that need to hand off to the platform's Maps app don't each
 * reimplement this behavior.
 */
export function openMapsDirections(lat: number, lon: number, name: string): void {
  // `name` is a human-readable label (e.g. "Dana's SOS"), so it only goes where
  // Maps treats it as one: Apple's `q=`. It used to be passed to Google's
  // `destination_place_id`, which takes a Google Place ID and — per Google's
  // documented URL contract — takes PRECEDENCE over `destination`, so the one
  // parameter that actually carried the coordinates was being outranked by a
  // value Maps has no way to resolve. On the SOS path that is the difference
  // between a route to a stranded friend and no destination at all.
  const encodedName = encodeURIComponent(name);
  const appleUrl = `maps://maps.apple.com/?daddr=${lat},${lon}&q=${encodedName}`;
  const googleUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;

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
