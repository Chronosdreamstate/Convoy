/**
 * HazardReportModal — the confirmation toast's auto-close timer.
 *
 * The toast holds the sheet open for 2.2s and then closes it. That timer used
 * to outlive the sheet, so reporting a hazard, dismissing the sheet, and
 * reopening it inside those 2.2 seconds had the stale timer fire onClose() and
 * shut the new sheet mid-report.
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';

const mockApiPost = jest.fn();
jest.mock('../services/apiClient', () => ({
  apiClient: { post: (...a: unknown[]) => mockApiPost(...a) },
}));

jest.mock('../services/OfflineCacheService', () => ({
  SQLiteOfflineDB: class {
    init = jest.fn().mockResolvedValue(undefined);
    saveHazard = jest.fn().mockResolvedValue(undefined);
  },
}));

import HazardReportModal from './HazardReportModal';

function press(root: ReactTestInstance, label: string): Promise<void> {
  const node = root.findAll(
    (n) => n.props?.accessibilityLabel === label && typeof n.props?.onPress === 'function',
  )[0];
  if (!node) throw new Error(`no pressable labelled "${label}"`);
  return act(async () => { node.props.onPress(); });
}

function labels(root: ReactTestInstance): string[] {
  return [...new Set(
    root
      .findAll((n) => typeof n.props?.accessibilityLabel === 'string' && typeof n.props?.onPress === 'function')
      .map((n) => n.props.accessibilityLabel as string),
  )];
}

async function advance(ms: number): Promise<void> {
  await act(async () => { jest.advanceTimersByTime(ms); });
  await act(async () => {});
}

beforeEach(() => {
  jest.useFakeTimers();
  mockApiPost.mockReset();
  mockApiPost.mockResolvedValue({ data: { id: 'h-1' } });
});

afterEach(() => { jest.useRealTimers(); });

describe('HazardReportModal auto-close', () => {
  async function renderSheet(onClose: jest.Mock) {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <HazardReportModal visible onClose={onClose} lat={51.5} lng={-0.12} />,
      );
    });
    await act(async () => {});
    return renderer;
  }

  it('closes itself once the confirmation has been shown', async () => {
    const onClose = jest.fn();
    const renderer = await renderSheet(onClose);

    const typeLabel = labels(renderer.root).find((l) => l.toLowerCase().includes('pothole'))!;
    await press(renderer.root, typeLabel);
    await press(renderer.root, 'Report Hazard');

    expect(onClose).not.toHaveBeenCalled(); // toast is still up
    await advance(2500);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close a sheet the user reopened while the old timer was pending', async () => {
    const onClose = jest.fn();
    const renderer = await renderSheet(onClose);

    const typeLabel = labels(renderer.root).find((l) => l.toLowerCase().includes('pothole'))!;
    await press(renderer.root, typeLabel);
    await press(renderer.root, 'Report Hazard');

    // The user dismisses the sheet immediately, then opens it again.
    await act(async () => {
      renderer.update(<HazardReportModal visible={false} onClose={onClose} lat={51.5} lng={-0.12} />);
    });
    await act(async () => {
      renderer.update(<HazardReportModal visible onClose={onClose} lat={51.5} lng={-0.12} />);
    });

    await advance(2500);

    // The second sheet is still open — the first sheet's timer is gone.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('drops its pending timer when unmounted', async () => {
    const onClose = jest.fn();
    const renderer = await renderSheet(onClose);

    const typeLabel = labels(renderer.root).find((l) => l.toLowerCase().includes('pothole'))!;
    await press(renderer.root, typeLabel);
    await press(renderer.root, 'Report Hazard');

    await act(async () => { renderer.unmount(); });
    await advance(2500);

    expect(onClose).not.toHaveBeenCalled();
  });
});
