/**
 * Canonical form for an email address used as an account identity.
 *
 * Mail domains are case-insensitive and every mainstream provider treats the
 * local part that way too, so `Foo@Example.com` and `foo@example.com` are one
 * person. Storing them verbatim gave them two accounts (users.email's UNIQUE
 * constraint is case-sensitive) and made "wrong" capitalisation at the login
 * screen look like a bad password.
 *
 * Every read and write of users.email goes through this, and migration 034
 * backs it with a UNIQUE INDEX on lower(email) so a future code path that
 * forgets still cannot create a second account for the same address.
 *
 * Deliberately NOT doing provider-specific canonicalisation (stripping dots or
 * +tags for Gmail): those rules differ per provider, and folding them would
 * merge addresses their owners consider distinct.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
