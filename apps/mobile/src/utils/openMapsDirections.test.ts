/**
 * Unit tests for openMapsDirections.
 *
 * This is the emergency path: it's what "Get Directions" on a friend's SOS pin
 * hands to the platform's Maps app (see IdleMapScreen's handleSosPinPress).
 * The one thing that must hold is that the coordinates survive the hand-off —
 * a rider tapping through to a mate who has broken down gets a route or
 * nothing at all.
 */

import { Linking, Platform } from 'react-native';
import { openMapsDirections } from './openMapsDirections';

/** Works whether Platform.OS is a data property or an object-literal getter. */
function setPlatformOS(os: 'ios' | 'android') {
  Object.defineProperty(Platform, 'OS', { get: () => os, configurable: true });
}

const originalOS = Platform.OS;

let openURL: jest.SpyInstance;
let canOpenURL: jest.SpyInstance;

beforeEach(() => {
  openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  canOpenURL = jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
});

afterEach(() => {
  jest.restoreAllMocks();
  setPlatformOS(originalOS as 'ios' | 'android');
});

describe('openMapsDirections — Google Maps URL', () => {
  beforeEach(() => setPlatformOS('android'));

  it('never passes a display name as destination_place_id', async () => {
    // destination_place_id takes a Google Place ID and, per Google's URL
    // contract, takes PRECEDENCE over destination — so stuffing a member's
    // display name in there hands Maps a destination it cannot resolve and
    // silently outranks the coordinates we actually have.
    openMapsDirections(37.7749, -122.4194, "Dana's SOS");
    await Promise.resolve();

    const url = openURL.mock.calls[0][0] as string;
    expect(url).not.toContain('destination_place_id');
  });

  it('routes to the SOS coordinates', async () => {
    openMapsDirections(37.7749, -122.4194, "Dana's SOS");
    await Promise.resolve();

    expect(openURL).toHaveBeenCalledWith(
      'https://www.google.com/maps/dir/?api=1&destination=37.7749,-122.4194',
    );
  });
});

describe('openMapsDirections — Apple Maps URL', () => {
  beforeEach(() => setPlatformOS('ios'));

  it('keeps the human-readable name where it is valid (the q= label)', async () => {
    openMapsDirections(37.7749, -122.4194, "Dana's SOS");
    await Promise.resolve();
    await Promise.resolve();

    expect(canOpenURL).toHaveBeenCalled();
    expect(openURL).toHaveBeenCalledWith(
      `maps://maps.apple.com/?daddr=37.7749,-122.4194&q=${encodeURIComponent("Dana's SOS")}`,
    );
  });

  it('falls back to the Google URL when Apple Maps cannot be opened', async () => {
    canOpenURL.mockResolvedValue(false);
    openMapsDirections(37.7749, -122.4194, "Dana's SOS");
    await Promise.resolve();
    await Promise.resolve();

    const url = openURL.mock.calls[0][0] as string;
    expect(url).toContain('destination=37.7749,-122.4194');
    expect(url).not.toContain('destination_place_id');
  });
});
