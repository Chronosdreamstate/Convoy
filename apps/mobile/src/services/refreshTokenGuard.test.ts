import { singleFlightRefresh, __resetRefreshGuard } from './refreshTokenGuard';

describe('singleFlightRefresh', () => {
  beforeEach(() => __resetRefreshGuard());

  it('runs the refresh and returns its token', async () => {
    const refresh = jest.fn().mockResolvedValue('tok-1');
    await expect(singleFlightRefresh(refresh)).resolves.toBe('tok-1');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent callers into a single refresh, sharing the result', async () => {
    let resolve!: (t: string) => void;
    const refreshA = jest.fn(() => new Promise<string>((r) => { resolve = r; }));
    const refreshB = jest.fn().mockResolvedValue('tok-B');

    // A starts and holds the in-flight refresh; B arrives while it's pending.
    const aPromise = singleFlightRefresh(refreshA);
    const bPromise = singleFlightRefresh(refreshB);

    expect(refreshB).not.toHaveBeenCalled(); // B did not fire a second /auth/refresh

    resolve('tok-A');
    // Both callers see the same rotated token from the single request.
    await expect(aPromise).resolves.toBe('tok-A');
    await expect(bPromise).resolves.toBe('tok-A');
    expect(refreshA).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh refresh once the previous one settled', async () => {
    await singleFlightRefresh(jest.fn().mockResolvedValue('tok-1'));
    const next = jest.fn().mockResolvedValue('tok-2');
    await expect(singleFlightRefresh(next)).resolves.toBe('tok-2');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('clears the in-flight slot even when the refresh rejects', async () => {
    await expect(
      singleFlightRefresh(() => Promise.reject(new Error('network'))),
    ).rejects.toThrow('network');

    // A rejection must not wedge the guard — the next refresh still runs.
    const after = jest.fn().mockResolvedValue('tok-after');
    await expect(singleFlightRefresh(after)).resolves.toBe('tok-after');
  });
});
