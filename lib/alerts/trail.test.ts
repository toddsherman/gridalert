import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { advanceTrail, biggestJump, EMPTY_TRAIL, estimateOnset, latestRise } from './trail.ts';

const THRESHOLD = 10_000;

function replay(values: number[], key = 'metro:1') {
  let trail = EMPTY_TRAIL;
  values.forEach((people, i) => {
    trail = advanceTrail(trail, [{ key, people }], i, THRESHOLD);
  });
  return trail;
}

describe('estimateOnset', () => {
  it('dates a sudden jump to its first poll', () => {
    assert.equal(estimateOnset(replay([3000, 3100, 2900, 3000, 9000, 12000, 13000]), 'metro:1'), 4);
  });

  it('ignores a steady background above the keep level', () => {
    assert.equal(estimateOnset(replay([4000, 4100, 3900, 4050, 4000, 30000]), 'metro:1'), 5);
  });

  it('dates a slow climb to where it left the baseline', () => {
    assert.equal(estimateOnset(replay([500, 500, 3000, 6000, 9000, 12000]), 'metro:1'), 2);
  });

  it('dates to where readings became worth keeping', () => {
    assert.equal(estimateOnset(replay([0, 0, 0, 0, 12000, 15000]), 'metro:1'), 4);
  });

  it('falls back to the earliest record when already high', () => {
    assert.equal(estimateOnset(replay([20000, 20000, 20000]), 'metro:1'), 0);
  });

  it('uses the latest poll for an area with no readings', () => {
    assert.equal(estimateOnset(replay([100, 100]), 'metro:2'), 1);
  });
});

describe('latestRise', () => {
  it('finds a jump on top of an outage already under way', () => {
    assert.deepEqual(latestRise(replay([12_000, 12_000, 12_000, 12_000, 40_000, 60_000]), 'metro:1'), { at: 4, people: 48_000 });
  });

  it('ignores small wobbles in a plateau', () => {
    assert.equal(latestRise(replay([12_000, 12_100, 12_000, 12_050]), 'metro:1'), null);
  });

  it('finds nothing while the count is falling', () => {
    assert.equal(latestRise(replay([60_000, 40_000, 20_000]), 'metro:1'), null);
  });

  it('finds nothing with too little history', () => {
    assert.equal(latestRise(replay([60_000]), 'metro:1'), null);
    assert.equal(latestRise(replay([100]), 'metro:2'), null);
  });
});

describe('advanceTrail', () => {
  it('drops areas that stay below the keep level', () => {
    assert.deepEqual(replay([100, 200, 300]).people, {});
  });

  it('keeps series aligned to the end of the poll times', () => {
    const trail = replay([0, 0, 5000, 6000]);
    assert.equal(trail.t.length, 4);
    assert.deepEqual(trail.people['metro:1'], [5000, 6000]);
  });

  it('is bounded to six hours of polls', () => {
    const trail = replay(new Array(100).fill(5000));
    assert.equal(trail.t.length, 72);
    assert.equal(trail.people['metro:1'].length, 72);
  });
});

describe('biggestJump', () => {
  const MINUTE = 60_000;
  const timed = (values: number[], minutes = 5) => {
    let trail = EMPTY_TRAIL;
    values.forEach((people, i) => {
      trail = advanceTrail(trail, [{ key: 'metro:1', people }], i * minutes * MINUTE, THRESHOLD);
    });
    return trail;
  };
  const jump = (values: number[], since = 0, minutes = 5) => biggestJump(timed(values, minutes), 'metro:1', since, 30 * MINUTE);

  it('finds a step', () => {
    assert.equal(jump([5000, 5000, 80000, 80000]), 75000);
  });

  it('finds a rise spread across the window', () => {
    assert.equal(jump([0, 2000, 10000, 20000, 30000, 40000, 50000]), 50000);
  });

  it('only looks across the window, so a slow climb stays small', () => {
    assert.equal(jump([0, 10000, 20000, 30000, 40000, 50000, 60000, 70000, 80000]), 60000);
    assert.equal(jump(Array.from({ length: 13 }, (_, i) => i * 2000)), 12000);
  });

  it('counts the first reading of an area that was quiet until then', () => {
    assert.equal(jump([0, 0, 0, 90000]), 90000);
    assert.equal(biggestJump(advanceTrail({ t: [0, 1, 2], people: {} }, [{ key: 'metro:1', people: 90000 }], 3, THRESHOLD), 'metro:1', 0, 30 * MINUTE), 90000);
  });

  it('ignores a jump from before the blackout began', () => {
    assert.equal(jump([0, 90000, 0, 0, 5000], 10 * MINUTE), 5000);
  });

  it('reads the same at 15-minute samples, as the history replay does', () => {
    assert.equal(jump([1000, 1000, 61000, 61000], 0, 15), 60000);
  });

  it('knows nothing about an area with no trail', () => {
    assert.equal(biggestJump(EMPTY_TRAIL, 'metro:1', 0, 30 * MINUTE), 0);
  });
});

describe('a feed that fails and comes back', () => {
  const step = (trail: typeof EMPTY_TRAIL, at: number, people: number, complete: boolean) => advanceTrail(trail, [{ key: 'metro:1', people, complete }], at, THRESHOLD);

  it('does not read as a jump, because the count holds while data is missing', () => {
    let trail = step(EMPTY_TRAIL, 0, 60000, true);
    trail = step(trail, 1, 0, false);
    trail = step(trail, 2, 0, false);
    trail = step(trail, 3, 60000, true);
    assert.deepEqual(trail.people['metro:1'], [60000, 60000, 60000, 60000]);
    assert.equal(biggestJump(trail, 'metro:1', 0, 10), 0);
  });

  it('still takes a higher reading while data is missing', () => {
    const trail = step(step(EMPTY_TRAIL, 0, 5000, true), 1, 9000, false);
    assert.equal(trail.people['metro:1'][1], 9000);
  });

  it('takes a lower reading once data is complete again', () => {
    const trail = step(step(step(EMPTY_TRAIL, 0, 60000, true), 1, 0, false), 2, 2000, true);
    assert.equal(trail.people['metro:1'].at(-1), 2000);
  });
});
