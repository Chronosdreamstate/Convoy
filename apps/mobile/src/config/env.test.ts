/**
 * Release-build configuration checks.
 *
 * EXPO_PUBLIC_* values are inlined when the bundle is built, so a build made
 * without them cannot recover at runtime. The failure this guards against was
 * entirely silent: EXPO_PUBLIC_API_URL defaulted to http://localhost:3000, so
 * every request went to the handset itself, failed as a network error, and the
 * app reported itself as offline forever with nothing explaining why.
 */

import { productionConfigErrors } from './env';

const GOOD = {
  apiUrl: 'https://api.convoy.app',
  mapboxToken: 'pk.eyJ1IjoiY29udm95IiwiYSI6ImNsIn0.abc123',
};

describe('productionConfigErrors', () => {
  it('passes a fully configured release build', () => {
    expect(productionConfigErrors(GOOD)).toEqual([]);
  });

  it('catches a missing API URL', () => {
    const errors = productionConfigErrors({ ...GOOD, apiUrl: '' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('EXPO_PUBLIC_API_URL');
  });

  it.each([
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://10.0.2.2:3000', // the Android emulator host alias in .env.example
    'https://localhost',
  ])('rejects %s — it resolves to the phone itself', (apiUrl) => {
    const errors = productionConfigErrors({ ...GOOD, apiUrl });
    expect(errors.join(' ')).toMatch(/phone itself/);
  });

  it('rejects cleartext http, which iOS blocks in release builds', () => {
    const errors = productionConfigErrors({ ...GOOD, apiUrl: 'http://api.convoy.app' });
    expect(errors.join(' ')).toMatch(/https/);
  });

  it('does not mistake a hostname merely containing "localhost" for loopback', () => {
    expect(productionConfigErrors({ ...GOOD, apiUrl: 'https://localhost.convoy.app' })).toEqual([]);
  });

  it('catches a missing map token', () => {
    const errors = productionConfigErrors({ ...GOOD, mapboxToken: '' });
    expect(errors.join(' ')).toContain('EXPO_PUBLIC_MAPBOX_TOKEN');
  });

  it('catches the placeholder token copied out of .env.example', () => {
    const errors = productionConfigErrors({
      ...GOOD,
      mapboxToken: 'pk.YOUR_MAPBOX_PUBLIC_TOKEN_HERE',
    });
    expect(errors.join(' ')).toMatch(/placeholder/);
  });

  it('reports every problem at once, so one rebuild can fix them all', () => {
    expect(productionConfigErrors({ apiUrl: '', mapboxToken: '' })).toHaveLength(2);
  });
});
