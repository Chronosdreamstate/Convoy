-- Migration 027: fuel_logs.odometer_km
--
-- `fuel_logs.mpg` has existed since migration 015 and the API even accepts a
-- client-supplied `mpg`, but nothing in the product ever collects an
-- odometer/mileage reading — AddModal in FuelLogScreen.tsx only asks for
-- gallons/price/date/notes — so `mpg` (and the "MPG This Week" chart) is
-- always empty in practice.
--
-- Adding an odometer reading per fill-up lets the API compute
-- distance-since-last-fill-up / gallons-used server-side, so `mpg` is
-- populated consistently regardless of client. Stored in km (metric,
-- canonical) to match the rest of the app's internal-metric /
-- display-converted-by-distanceUnit pattern (see DriveHistoryScreen.tsx,
-- which stores distance_m and only converts to miles for display).
ALTER TABLE fuel_logs ADD COLUMN IF NOT EXISTS odometer_km NUMERIC(10,2);

ALTER TABLE fuel_logs ADD CONSTRAINT fuel_logs_odometer_km_positive CHECK (odometer_km IS NULL OR odometer_km > 0);
