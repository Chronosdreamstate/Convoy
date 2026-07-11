import type { Config } from 'jest';

// Shared tsconfig overrides for ts-jest (workspace path alias).
const tsconfigOverrides = {
  paths: {
    '@convoy/api/*': ['src/*'],
  },
};

const config: Config = {
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.spec.ts'],
  transform: {
    // One ts-jest entry covering both project TypeScript and jose's .js ESM
    // files. jose@6 is ESM-only (`"type": "module"`, no CJS build), so its .js
    // files must be transpiled to CJS for jest. The ts-jest preset's transform
    // only covers `.tsx?`, which is why transformIgnorePatterns alone never
    // fixed this — jose's .js files had no transformer at all. This must be a
    // SINGLE entry: jest reuses one transformer instance per transformer
    // module, so a separate '\\.js$' ts-jest entry silently inherits the first
    // entry's options (and loses allowJs). `allowJs: true` lets ts-jest
    // transpile jose; with `checkJs` off (default) vendor JS is not
    // type-checked, so diagnostics for project TS are unchanged. `rootDir` is
    // widened to the monorepo root because ts-jest cannot emit for files
    // outside the tsconfig rootDir ("src"), and jose resolves into the
    // repo-root pnpm store.
    '^.+\\.[tj]sx?$': [
      'ts-jest',
      { tsconfig: { ...tsconfigOverrides, allowJs: true, rootDir: '../..' } },
    ],
  },
  // Transform jose but keep ignoring every other dependency. Must account for
  // pnpm's store layout, where the resolved path is
  //   node_modules/.pnpm/jose@x.y.z/node_modules/jose/dist/...
  // A plain `node_modules/(?!jose/)` matches at the first `node_modules/`
  // (followed by `.pnpm/`) and ignores the file anyway. This pattern fails the
  // negative lookahead at BOTH `node_modules/` segments for jose, and only for
  // jose. (Jest rewrites `/` in these patterns to the platform separator, so
  // this also works on Windows.)
  transformIgnorePatterns: ['node_modules/(?!(\\.pnpm/)?jose[@/])'],
  moduleNameMapper: {
    '^@convoy/api/(.*)$': '<rootDir>/src/$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
    '!src/index.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
};

export default config;
