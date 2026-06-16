/**
 * Unit tests for the migration runner utilities.
 * Tests migration file loading and ordering without a real database.
 */
import path from 'node:path';
import fs from 'node:fs';

describe('Migration file naming convention', () => {
  const migrationsDir = path.resolve(__dirname, 'migrations');

  it('migrations directory exists', () => {
    expect(fs.existsSync(migrationsDir)).toBe(true);
  });

  it('all migration files follow NNN_description.sql naming', () => {
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      expect(file).toMatch(/^\d+_.+\.sql$/);
    }
  });

  it('migration versions are unique', () => {
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const versions = files.map((f) => f.match(/^(\d+)_/)?.[1]);
    const uniqueVersions = new Set(versions);
    expect(uniqueVersions.size).toBe(versions.length);
  });

  it('001_initial_schema.sql contains PostGIS extension', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, '001_initial_schema.sql'), 'utf-8');
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS postgis');
  });

  it('001_initial_schema.sql contains all required tables', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, '001_initial_schema.sql'), 'utf-8');

    const requiredTables = [
      'CREATE TABLE users',
      'CREATE TABLE auth_providers',
      'CREATE TABLE devices',
      'CREATE TABLE vehicles',
      'CREATE TABLE friendships',
      'CREATE TABLE convoy_groups',
      'CREATE TABLE convoy_members',
      'CREATE TABLE ptt_channels',
      'CREATE TABLE ptt_channel_members',
      'CREATE TABLE ptt_log',
      'CREATE TABLE hazard_reports',
      'CREATE TABLE hazard_votes',
      'CREATE TABLE drive_history',
      'CREATE TABLE rally_points',
      'CREATE TABLE user_settings',
    ];

    for (const table of requiredTables) {
      expect(sql).toContain(table);
    }
  });

  it('001_initial_schema.sql has GIST index on hazard_reports.location', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, '001_initial_schema.sql'), 'utf-8');
    expect(sql).toContain('USING GIST (location)');
  });

  it('001_initial_schema.sql uses GEOGRAPHY for hazard location and rally points', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, '001_initial_schema.sql'), 'utf-8');
    expect(sql).toContain('GEOGRAPHY(Point, 4326)');
  });
});
