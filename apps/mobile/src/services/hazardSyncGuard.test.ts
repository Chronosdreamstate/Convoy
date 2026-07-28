import { runExclusiveHazardDrain, __resetHazardDrainGuard } from './hazardSyncGuard';

describe('runExclusiveHazardDrain', () => {
  beforeEach(() => __resetHazardDrainGuard());

  it('runs the drain when nothing is in flight', async () => {
    const drain = jest.fn().mockResolvedValue(undefined);
    await runExclusiveHazardDrain(drain);
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('skips a concurrent drain while the first is still running', async () => {
    let release!: () => void;
    const first = jest.fn(() => new Promise<void>((r) => { release = r; }));
    const second = jest.fn().mockResolvedValue(undefined);

    const firstPromise = runExclusiveHazardDrain(first); // starts, holds the guard
    await runExclusiveHazardDrain(second);               // guard held → skipped
    expect(second).not.toHaveBeenCalled();

    release();
    await firstPromise;
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('releases the guard so a later drain runs', async () => {
    await runExclusiveHazardDrain(jest.fn().mockResolvedValue(undefined));
    const later = jest.fn().mockResolvedValue(undefined);
    await runExclusiveHazardDrain(later);
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('releases the guard even when the drain throws', async () => {
    await expect(
      runExclusiveHazardDrain(() => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    const after = jest.fn().mockResolvedValue(undefined);
    await runExclusiveHazardDrain(after);
    expect(after).toHaveBeenCalledTimes(1);
  });
});
