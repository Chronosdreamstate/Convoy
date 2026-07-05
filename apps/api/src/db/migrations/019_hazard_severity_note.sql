-- Migration 006: Add severity and note fields to hazard_reports
-- Supports richer hazard reports submitted from the mobile HazardReportModal.

ALTER TABLE hazard_reports
  ADD COLUMN IF NOT EXISTS severity TEXT DEFAULT 'medium'
    CHECK (severity IN ('low', 'medium', 'high'));

ALTER TABLE hazard_reports
  ADD COLUMN IF NOT EXISTS note TEXT;

-- Index to allow future filtering/analytics by severity
CREATE INDEX IF NOT EXISTS idx_hazard_reports_severity
  ON hazard_reports (severity) WHERE status = 'active';
