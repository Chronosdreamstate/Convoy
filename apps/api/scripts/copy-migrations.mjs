/**
 * Copy the .sql migration files into the compiled output.
 *
 * tsc only emits JavaScript, so without this dist/db/migrations/ is missing
 * entirely and the compiled runner has nothing to apply. Kept as a plain node
 * script (no cp -r, no extra dependency) so it behaves the same on the Windows
 * dev machine and in the Linux build image.
 */

import { cpSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(apiRoot, 'src', 'db', 'migrations');
const dest = join(apiRoot, 'dist', 'db', 'migrations');

if (!existsSync(src)) {
  console.error(`[build] Migration source directory missing: ${src}`);
  process.exit(1);
}

cpSync(src, dest, { recursive: true });

const copied = readdirSync(dest).filter((f) => f.endsWith('.sql'));
if (copied.length === 0) {
  console.error('[build] No .sql files were copied — the compiled runner would apply nothing.');
  process.exit(1);
}

console.log(`[build] Copied ${copied.length} migration(s) to dist/db/migrations`);
