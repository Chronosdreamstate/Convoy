/**
 * Property tests for MotionStateService state machine.
 *
 * Property 81: Instant transition to in_motion on first above-threshold reading
 *   Validates: Requirements 30.2
 *
 * Property 82: Requires 3 consecutive below-threshold readings to transition to parked
 *   Validates: Requirements 30.3
 *
 * Property 83: Listener is notified exactly once per state change
 *   Validates: Requirements 30.4
 *
 * Property 84: Unsubscribing prevents future listener calls
 *   Validates: Requirements 30.4
 */

import fc from 'fast-check';
import { MotionStateService } from './MotionStateService';

const THRESHOLD_KPH = 5 * 1.60934; // ≈ 8.047 kph — same constant as production
const FAST = THRESHOLD_KPH + 1;    // above threshold → in_motion
const SLOW = 0;                     // below threshold → parked

// ---------------------------------------------------------------------------
// Property 81: Instant transition to in_motion
// ---------------------------------------------------------------------------
describe('Property 81: Instant transition to in_motion on above-threshold reading', () => {
  it('single fast reading transitions parked → in_motion', () => {
    const svc = new MotionStateService();
    expect(svc.state).toBe('parked');
    svc.update(FAST);
    expect(svc.state).toBe('in_motion');
  });

  it('any above-threshold speed triggers in_motion', () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(THRESHOLD_KPH + 0.001), max: 300, noNaN: true }),
        (speed) => {
          const svc = new MotionStateService();
          svc.update(speed);
          expect(svc.state).toBe('in_motion');
        },
      ),
    );
  });

  it('once in_motion, additional fast readings keep state at in_motion', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        (extraFastReadings) => {
          const svc = new MotionStateService();
          svc.update(FAST);
          expect(svc.state).toBe('in_motion');

          for (let i = 0; i < extraFastReadings; i++) {
            svc.update(FAST);
          }
          expect(svc.state).toBe('in_motion');
        },
      ),
      { numRuns: 20 },
    );
  });

  it('mixed fast reading after slow readings immediately reverts to in_motion', () => {
    const svc = new MotionStateService();
    svc.update(FAST); // → in_motion
    svc.update(SLOW); // below-threshold 1
    svc.update(SLOW); // below-threshold 2 (not yet parked)
    svc.update(FAST); // immediately back to in_motion
    expect(svc.state).toBe('in_motion');
  });
});

// ---------------------------------------------------------------------------
// Property 82: Requires 3 consecutive below-threshold readings to park
// ---------------------------------------------------------------------------
describe('Property 82: Requires 3 consecutive slow readings to transition to parked', () => {
  it('1 slow reading after in_motion does NOT park', () => {
    const svc = new MotionStateService();
    svc.update(FAST);
    svc.update(SLOW); // 1 slow
    expect(svc.state).toBe('in_motion');
  });

  it('2 slow readings after in_motion does NOT park', () => {
    const svc = new MotionStateService();
    svc.update(FAST);
    svc.update(SLOW);
    svc.update(SLOW); // 2 slow
    expect(svc.state).toBe('in_motion');
  });

  it('exactly 3 slow readings after in_motion transitions to parked', () => {
    const svc = new MotionStateService();
    svc.update(FAST);
    svc.update(SLOW);
    svc.update(SLOW);
    svc.update(SLOW); // 3 slow → parked
    expect(svc.state).toBe('parked');
  });

  it('slow counter resets after a fast reading interrupts the sequence', () => {
    const svc = new MotionStateService();
    svc.update(FAST); // → in_motion
    svc.update(SLOW); // 1
    svc.update(SLOW); // 2
    svc.update(FAST); // counter reset
    svc.update(SLOW); // 1 (fresh count)
    svc.update(SLOW); // 2
    expect(svc.state).toBe('in_motion'); // still in_motion, need 1 more
    svc.update(SLOW); // 3
    expect(svc.state).toBe('parked');
  });

  it('N fast + exactly 3 slow always results in parked', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        (fastCount) => {
          const svc = new MotionStateService();
          for (let i = 0; i < fastCount; i++) svc.update(FAST);
          svc.update(SLOW);
          svc.update(SLOW);
          svc.update(SLOW);
          expect(svc.state).toBe('parked');
        },
      ),
      { numRuns: 20 },
    );
  });

  it('starting from parked, slow readings keep state at parked', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        (slowCount) => {
          const svc = new MotionStateService();
          for (let i = 0; i < slowCount; i++) svc.update(SLOW);
          expect(svc.state).toBe('parked');
        },
      ),
      { numRuns: 15 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 83: Listener is notified exactly once per state change
// ---------------------------------------------------------------------------
describe('Property 83: Listener notified exactly once per state change', () => {
  it('listener fires once on parked → in_motion transition', () => {
    const svc = new MotionStateService();
    const events: string[] = [];
    svc.subscribe((s) => events.push(s));

    svc.update(FAST);
    expect(events).toEqual(['in_motion']);
  });

  it('listener fires once on in_motion → parked transition (after 3 slow)', () => {
    const svc = new MotionStateService();
    const events: string[] = [];
    svc.subscribe((s) => events.push(s));

    svc.update(FAST);
    svc.update(SLOW);
    svc.update(SLOW);
    svc.update(SLOW);

    expect(events).toEqual(['in_motion', 'parked']);
  });

  it('repeated fast readings do not fire listener more than once', () => {
    const svc = new MotionStateService();
    const events: string[] = [];
    svc.subscribe((s) => events.push(s));

    svc.update(FAST);
    svc.update(FAST);
    svc.update(FAST);

    expect(events).toEqual(['in_motion']);
  });

  it('repeated slow readings do not fire listener after parked', () => {
    const svc = new MotionStateService();
    const events: string[] = [];
    svc.subscribe((s) => events.push(s));

    svc.update(FAST);  // → in_motion (1 event)
    svc.update(SLOW);
    svc.update(SLOW);
    svc.update(SLOW);  // → parked (2 events total)
    svc.update(SLOW);
    svc.update(SLOW);

    expect(events).toEqual(['in_motion', 'parked']);
  });

  it('multiple complete cycles fire correct sequence of events', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        (cycles) => {
          const svc = new MotionStateService();
          const events: string[] = [];
          svc.subscribe((s) => events.push(s));

          for (let i = 0; i < cycles; i++) {
            svc.update(FAST);           // → in_motion
            svc.update(SLOW);
            svc.update(SLOW);
            svc.update(SLOW);           // → parked
          }

          // Each cycle produces exactly 2 events
          expect(events).toHaveLength(cycles * 2);
          for (let i = 0; i < cycles; i++) {
            expect(events[i * 2]).toBe('in_motion');
            expect(events[i * 2 + 1]).toBe('parked');
          }
        },
      ),
      { numRuns: 15 },
    );
  });

  it('multiple listeners all receive the same events', () => {
    const svc = new MotionStateService();
    const eventsA: string[] = [];
    const eventsB: string[] = [];
    svc.subscribe((s) => eventsA.push(s));
    svc.subscribe((s) => eventsB.push(s));

    svc.update(FAST);
    svc.update(SLOW);
    svc.update(SLOW);
    svc.update(SLOW);

    expect(eventsA).toEqual(eventsB);
    expect(eventsA).toEqual(['in_motion', 'parked']);
  });
});

// ---------------------------------------------------------------------------
// Property 84: Unsubscribing prevents future listener calls
// ---------------------------------------------------------------------------
describe('Property 84: Unsubscribing stops future listener notifications', () => {
  it('unsubscribe before any update — listener is never called', () => {
    const svc = new MotionStateService();
    const events: string[] = [];
    const unsub = svc.subscribe((s) => events.push(s));
    unsub();

    svc.update(FAST);
    svc.update(SLOW);
    svc.update(SLOW);
    svc.update(SLOW);

    expect(events).toHaveLength(0);
  });

  it('unsubscribe after first event — listener misses subsequent events', () => {
    const svc = new MotionStateService();
    const events: string[] = [];
    const unsub = svc.subscribe((s) => {
      events.push(s);
      unsub(); // unsubscribe after first call
    });

    svc.update(FAST);  // triggers in_motion, then unsubs
    svc.update(SLOW);
    svc.update(SLOW);
    svc.update(SLOW);  // would trigger parked if still subscribed

    expect(events).toEqual(['in_motion']);
  });

  it('one listener unsubscribed while another stays — remaining fires normally', () => {
    const svc = new MotionStateService();
    const eventsA: string[] = [];
    const eventsB: string[] = [];
    const unsubA = svc.subscribe((s) => eventsA.push(s));
    svc.subscribe((s) => eventsB.push(s));

    svc.update(FAST); // both receive in_motion
    unsubA();
    svc.update(SLOW);
    svc.update(SLOW);
    svc.update(SLOW); // only B receives parked

    expect(eventsA).toEqual(['in_motion']);
    expect(eventsB).toEqual(['in_motion', 'parked']);
  });
});
