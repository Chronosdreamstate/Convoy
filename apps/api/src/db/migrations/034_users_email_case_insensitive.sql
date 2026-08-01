-- Migration 034: emails identify an account case-insensitively.
--
-- Context: users.email was stored exactly as typed and guarded only by the
-- case-SENSITIVE UNIQUE constraint from 001. So `Foo@Example.com` and
-- `foo@example.com` were two different accounts:
--   * signing up a second time with different capitalisation created a
--     parallel account instead of hitting EMAIL_EXISTS;
--   * signing in with different capitalisation than you registered with
--     looked exactly like a wrong password;
--   * a social provider echoing back the user's original capitalisation
--     (upsertUserBySocial's ON CONFLICT (email)) could fork the same person
--     into a second account.
--
-- The application now folds every email through normalizeEmail() (auth/email.ts)
-- before it is read or written. This migration makes the DATABASE enforce the
-- same rule, so a future code path that forgets to normalize cannot quietly
-- reintroduce the split.
--
-- Two steps: fold what is already stored, then add the constraint.
--
-- "Folded" here is lower(btrim(...)), matching normalizeEmail() exactly. The
-- trim matters because social providers hand us their email string unvalidated
-- (no zod schema in that path), and a stored " foo@x.com" could never be
-- matched by a login attempt the app has already trimmed.

-- 1. Fold existing addresses, but ONLY where the folded form belongs to exactly
--    one account. Folding a contested address would trip UNIQUE(email) here and
--    fail the deploy with a raw constraint error; leaving those rows alone lets
--    the guard below report them in terms an operator can act on.
WITH folded AS (
  SELECT id, lower(btrim(email)) AS canonical
  FROM users
  WHERE email IS NOT NULL
),
uncontested AS (
  SELECT canonical FROM folded GROUP BY canonical HAVING COUNT(*) = 1
)
UPDATE users u
SET email = f.canonical,
    updated_at = now()
FROM folded f
JOIN uncontested c ON c.canonical = f.canonical
WHERE u.id = f.id
  AND u.email <> f.canonical;

-- 2. Refuse to continue if any address is still claimed by two accounts.
--    Merging them would silently hand one person's convoys, drives and DMs to
--    another, and blanking the loser's email would lock them out — neither is
--    a decision a migration gets to make. Deployment stops here with the
--    offending addresses named so an operator can resolve them deliberately.
DO $$
DECLARE
  dupes TEXT;
BEGIN
  SELECT string_agg(folded, ', ')
  INTO dupes
  FROM (
    SELECT lower(btrim(email)) AS folded
    FROM users
    WHERE email IS NOT NULL
    GROUP BY lower(btrim(email))
    HAVING COUNT(*) > 1
  ) d;

  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce case-insensitive emails: these addresses belong to more than one account: %. Merge or clear the duplicates, then re-run the migration.',
      dupes;
  END IF;
END $$;

-- 3. The guarantee itself. The plain UNIQUE(email) from 001 stays: it is what
--    the existing ON CONFLICT (email) upserts arbitrate on, and with every
--    write normalized the two constraints agree.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower
  ON users (lower(btrim(email)))
  WHERE email IS NOT NULL;
