/**
 * Regression test for jest ESM handling of `jose`.
 *
 * jose@6 is ESM-only (its package.json has `"type": "module"` and ships only
 * `dist/webapi/*.js` ESM builds — no CJS). Under jest's default CJS runtime,
 * requiring it raises `SyntaxError: Unexpected token 'export'` unless the
 * config transforms jose's .js files:
 *   1. the transform must cover `.js` files (the ts-jest preset only covers
 *      `.tsx?` by default), and
 *   2. transformIgnorePatterns must not match jose under pnpm's store layout
 *      (`node_modules/.pnpm/jose@x.y.z/node_modules/jose/...`).
 *
 * This suite deliberately does NOT `jest.mock('jose')` — it imports the real
 * app module graph (app.ts -> auth.routes.ts -> jose) so any regression in
 * jest.config.ts surfaces here as an import failure.
 */

describe('real app module graph (no jose mock)', () => {
  it('imports the real jose ESM build', async () => {
    const jose = await import('jose');
    expect(typeof jose.jwtVerify).toBe('function');
    expect(typeof jose.createRemoteJWKSet).toBe('function');
  });

  it('imports auth.routes, which depends on jose', async () => {
    const authRoutes = await import('./auth/auth.routes');
    expect(typeof authRoutes.default).toBe('function');
  });

  it('imports the real app and exposes buildApp', async () => {
    const appModule = await import('./app');
    expect(typeof appModule.buildApp).toBe('function');
  });
});
