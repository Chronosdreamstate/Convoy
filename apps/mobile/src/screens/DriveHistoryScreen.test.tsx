/**
 * Unit tests for DriveHistoryScreen's data handling.
 *
 * The screen had render coverage only, so none of its handlers had ever run.
 * These cover the ones that either lose user data or mislead:
 *  - CSV export must contain the WHOLE history, not the pages the list
 *    happens to have scrolled to (the header states lifetime totals, so a
 *    short file reads as complete), and must say so when it can't.
 *  - Delete removes the row and refreshes the lifetime totals it was counted in.
 *  - A failed load-more must not advance the page cursor past unread history.
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Alert, Share } from 'react-native';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

const mockApiGet = jest.fn();
const mockApiPost = jest.fn();
const mockApiDelete = jest.fn();
jest.mock('../services/apiClient', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
    delete: (...args: unknown[]) => mockApiDelete(...args),
  },
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
}));

const mockWriteAsStringAsync = jest.fn().mockResolvedValue(undefined);
jest.mock('expo-file-system/legacy', () => ({
  get cacheDirectory() { return 'file:///cache/'; },
  writeAsStringAsync: (...args: unknown[]) => mockWriteAsStringAsync(...args),
}));

const mockShareAsync = jest.fn().mockResolvedValue(undefined);
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(true),
  shareAsync: (...args: unknown[]) => mockShareAsync(...args),
}));

jest.mock('react-native-maps', () => {
  const { View } = jest.requireActual('react-native');
  return { __esModule: true, default: View, Polyline: View, PROVIDER_DEFAULT: 'default' };
});

import DriveHistoryScreen, { dateKey } from './DriveHistoryScreen';
import { useSettingsStore } from '../stores/settingsStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeDrive {
  id: string;
  distanceM: number;
  durationS: number;
  memberCount: number;
  startedAt: string;
  endedAt: string;
  groupId: string | null;
  avgSpeedKph: number;
  topSpeedKph: number;
  routeTrace: { type: 'LineString'; coordinates: [number, number][] };
}

function makeDrives(count: number, offset = 0): FakeDrive[] {
  return Array.from({ length: count }, (_, i) => {
    const n = offset + i;
    return {
      id: `drive-${n}`,
      distanceM: 1000 * (n + 1),
      durationS: 600,
      memberCount: 1,
      startedAt: `2026-07-${String((n % 28) + 1).padStart(2, '0')}T09:00:00.000Z`,
      endedAt: `2026-07-${String((n % 28) + 1).padStart(2, '0')}T10:00:00.000Z`,
      groupId: null,
      avgSpeedKph: 50,
      topSpeedKph: 90,
      routeTrace: { type: 'LineString' as const, coordinates: [[0, 0], [1, 1]] as [number, number][] },
    };
  });
}

/** Serves /drives page-by-page and /drives/stats, like the real API. */
function serveHistory(total: number, pageSize = 20) {
  mockApiGet.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/v1/drives/stats')) {
      return { data: { totalDrives: total, totalDistanceM: 1000, totalDurationS: 600 } };
    }
    const page = Number(/page=(\d+)/.exec(url)?.[1] ?? 1);
    const limit = Number(/limit=(\d+)/.exec(url)?.[1] ?? pageSize);
    const start = (page - 1) * limit;
    return {
      data: {
        drives: makeDrives(Math.max(0, Math.min(limit, total - start)), start),
        pagination: { pages: Math.ceil(total / limit), total },
      },
    };
  });
}

async function renderScreen(): Promise<ReactTestInstance> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<DriveHistoryScreen />);
  });
  await act(async () => {});
  return renderer.root;
}

function byLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  const nodes = root.findAll(
    (n) => n.props?.accessibilityLabel === label && typeof n.props?.onPress === 'function',
  );
  if (nodes.length === 0) throw new Error(`no pressable labelled "${label}"`);
  return nodes[0];
}

async function press(node: ReactTestInstance): Promise<void> {
  await act(async () => { await node.props.onPress(); });
}

/** The CSV handed to the file writer. */
function writtenCsv(): string {
  const call = mockWriteAsStringAsync.mock.calls.at(-1);
  if (!call) throw new Error('nothing was written');
  return call[1] as string;
}

function csvDataRows(csv: string): string[] {
  return csv.split('\r\n').slice(1).filter(Boolean);
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  mockApiGet.mockReset();
  mockApiPost.mockReset();
  mockApiDelete.mockReset();
  mockWriteAsStringAsync.mockClear();
  mockShareAsync.mockClear();
});

describe('DriveHistoryScreen CSV export', () => {
  it('exports every drive in the history, not just the loaded page', async () => {
    // 137 drives, 20 on screen. The header reports the lifetime count from
    // /drives/stats, so an export of the loaded 20 looks complete.
    serveHistory(137);
    const root = await renderScreen();

    await press(byLabel(root, 'Export drive history as CSV'));

    expect(csvDataRows(writtenCsv())).toHaveLength(137);
    expect(mockShareAsync).toHaveBeenCalled();
  });

  it('pages the export with the API-allowed maximum limit', async () => {
    serveHistory(137);
    const root = await renderScreen();
    mockApiGet.mockClear();

    await press(byLabel(root, 'Export drive history as CSV'));

    const exportUrls = mockApiGet.mock.calls
      .map((c) => c[0] as string)
      .filter((u) => u.startsWith('/api/v1/drives?'));
    expect(exportUrls).toEqual([
      '/api/v1/drives?page=1&limit=50',
      '/api/v1/drives?page=2&limit=50',
      '/api/v1/drives?page=3&limit=50',
    ]);
  });

  it('reports a failure instead of writing a partial file', async () => {
    serveHistory(137);
    const root = await renderScreen();
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    // The sweep dies partway through — page 1 fine, page 2 gone.
    let driveCalls = 0;
    mockApiGet.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/v1/drives/stats')) return { data: {} };
      driveCalls += 1;
      if (driveCalls > 1) throw new Error('offline');
      return { data: { drives: makeDrives(50), pagination: { pages: 3 } } };
    });

    await press(byLabel(root, 'Export drive history as CSV'));

    expect(mockWriteAsStringAsync).not.toHaveBeenCalled();
    expect(mockShareAsync).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith('Export failed', expect.stringContaining('full drive history'));
    alertSpy.mockRestore();
  });

  it('exports a single page history without extra requests', async () => {
    serveHistory(3);
    const root = await renderScreen();
    mockApiGet.mockClear();

    await press(byLabel(root, 'Export drive history as CSV'));

    const exportUrls = mockApiGet.mock.calls
      .map((c) => c[0] as string)
      .filter((u) => u.startsWith('/api/v1/drives?'));
    expect(exportUrls).toEqual(['/api/v1/drives?page=1&limit=50']);
    expect(csvDataRows(writtenCsv())).toHaveLength(3);
  });

  it('falls back to the share sheet as text when file sharing is unavailable', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sharing = require('expo-sharing');
    Sharing.isAvailableAsync.mockResolvedValueOnce(false);
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
    serveHistory(2);
    const root = await renderScreen();

    await press(byLabel(root, 'Export drive history as CSV'));

    expect(shareSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'CORTEGE Drive History' }),
    );
    // Whatever route it takes, the payload still carries the full history.
    const shared = (shareSpy.mock.calls[0][0] as { message: string }).message;
    expect(csvDataRows(shared)).toHaveLength(2);
    shareSpy.mockRestore();
  });
});

describe('DriveHistoryScreen delete', () => {
  it('removes the drive and re-reads the lifetime totals it was counted in', async () => {
    serveHistory(3);
    mockApiDelete.mockResolvedValue({ data: {} });
    const root = await renderScreen();

    // Open the detail view for the first drive, then confirm the delete.
    const row = root.findAll(
      (n) => typeof n.props?.accessibilityLabel === 'string'
        && n.props.accessibilityLabel.startsWith('Drive on ')
        && typeof n.props?.onPress === 'function',
    )[0];
    await press(row);

    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(((
      _title: string,
      _message: string,
      buttons: Array<{ text: string; onPress?: () => void }>,
    ) => {
      buttons.find((b) => b.text === 'Delete')?.onPress?.();
    }) as never);

    mockApiGet.mockClear();
    await press(byLabel(root, 'Delete drive record'));
    await act(async () => {});

    expect(mockApiDelete).toHaveBeenCalledWith('/api/v1/drives/drive-0');
    // Lifetime totals include the deleted drive, so they must be re-fetched.
    expect(mockApiGet.mock.calls.map((c) => c[0])).toContain('/api/v1/drives/stats');
    alertSpy.mockRestore();
  });

  it('keeps the drive and explains when the delete fails', async () => {
    serveHistory(3);
    mockApiDelete.mockRejectedValue(new Error('offline'));
    const root = await renderScreen();

    const row = root.findAll(
      (n) => typeof n.props?.accessibilityLabel === 'string'
        && n.props.accessibilityLabel.startsWith('Drive on ')
        && typeof n.props?.onPress === 'function',
    )[0];
    await press(row);

    const seen: string[] = [];
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(((
      title: string,
      _message: string,
      buttons?: Array<{ text: string; onPress?: () => void }>,
    ) => {
      seen.push(title);
      buttons?.find((b) => b.text === 'Delete')?.onPress?.();
    }) as never);

    await press(byLabel(root, 'Delete drive record'));
    await act(async () => {});

    expect(seen).toContain('Error');
    alertSpy.mockRestore();
  });
});

describe('DriveHistoryScreen paging', () => {
  it('does not advance the page cursor when load-more fails', async () => {
    serveHistory(60);
    const root = await renderScreen();

    const list = root.find((n) => typeof n.props?.onEndReached === 'function');

    // Page 2 fails — the cursor must stay put so the retry re-requests page 2
    // rather than skipping to page 3 and dropping 20 drives.
    mockApiGet.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { await list.props.onEndReached(); });
    await act(async () => {});

    mockApiGet.mockClear();
    serveHistory(60);
    await act(async () => { await list.props.onEndReached(); });
    await act(async () => {});

    const pagedUrls = mockApiGet.mock.calls
      .map((c) => c[0] as string)
      .filter((u) => u.startsWith('/api/v1/drives?'));
    expect(pagedUrls.some((u) => u.includes('page=2'))).toBe(true);
    expect(pagedUrls.some((u) => u.includes('page=3'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Distance/speed units + local-day grouping
// ---------------------------------------------------------------------------

/** Every literal string in the rendered host tree, flattened. */
function renderedText(renderer: TestRenderer.ReactTestRenderer): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object' && 'children' in (node as Record<string, unknown>)) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return out;
}

/** Renders and returns the renderer (the shared helper only exposes .root). */
async function renderRenderer(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<DriveHistoryScreen />); });
  await act(async () => {});
  return renderer;
}

/** One drive, ending at the given LOCAL wall-clock time. */
function driveAtLocal(id: string, d: Date, extra: Partial<FakeDrive> = {}): FakeDrive {
  return {
    id,
    distanceM: 16_093,
    durationS: 3600,
    memberCount: 1,
    startedAt: new Date(d.getTime() - 3_600_000).toISOString(),
    endedAt: d.toISOString(),
    groupId: null,
    avgSpeedKph: 50,
    topSpeedKph: 90,
    routeTrace: { type: 'LineString' as const, coordinates: [[0, 0], [1, 1]] as [number, number][] },
    ...extra,
  };
}

function serveDrives(drives: FakeDrive[]) {
  mockApiGet.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/v1/drives/stats')) {
      return { data: { totalDrives: drives.length, totalDistanceM: 16_093, totalDurationS: 3600 } };
    }
    return { data: { drives, pagination: { pages: 1, total: drives.length } } };
  });
}

describe('DriveHistoryScreen speed units', () => {
  afterEach(() => { useSettingsStore.setState({ distanceUnit: 'miles' }); });

  it('shows speeds in mph when distances are shown in miles', async () => {
    // Regression: distances honoured the preference while every speed was
    // hard-coded km/h, so one row read "10.0 mi · 1h · 50 km/h avg".
    useSettingsStore.setState({ distanceUnit: 'miles' });
    serveDrives([driveAtLocal('d-1', new Date(2026, 6, 1, 10, 0))]);
    const renderer = await renderRenderer();
    const text = renderedText(renderer);

    expect(text.some((t) => t.includes('31 mph avg'))).toBe(true);
    expect(text.some((t) => t.includes('km/h'))).toBe(false);
  });

  it('shows speeds in km/h when distances are shown in km', async () => {
    useSettingsStore.setState({ distanceUnit: 'km' });
    serveDrives([driveAtLocal('d-1', new Date(2026, 6, 1, 10, 0))]);
    const renderer = await renderRenderer();
    const text = renderedText(renderer);

    expect(text.some((t) => t.includes('50 km/h avg'))).toBe(true);
    expect(text.some((t) => t.includes('mph'))).toBe(false);
  });
});

describe('DriveHistoryScreen day grouping', () => {
  it('keys a drive to its LOCAL calendar day, not the UTC one', () => {
    // 23:30 and 00:30 local: whichever side of UTC this machine sits on, one
    // of the two crosses the UTC date line. The old `iso.substring(0, 10)`
    // reported the UTC day for it.
    expect(dateKey(new Date(2026, 8, 3, 23, 30).toISOString())).toBe('2026-09-03');
    expect(dateKey(new Date(2026, 8, 4, 0, 30).toISOString())).toBe('2026-09-04');
  });

  it('puts two drives from the same local day under a single header', async () => {
    // 01:00 and 22:00 on one local day straddle midnight UTC in either
    // direction, so under UTC keying this produced TWO section headers
    // carrying the identical (locally formatted) date.
    const day = new Date();
    day.setDate(day.getDate() - 30);
    const early = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 1, 0);
    const late = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 22, 0);
    // The list is newest-first, like the API.
    serveDrives([driveAtLocal('d-late', late), driveAtLocal('d-early', early)]);

    const renderer = await renderRenderer();
    const label = late.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const headers = renderedText(renderer).filter((t) => t === label);
    expect(headers).toHaveLength(1);
  });
});
