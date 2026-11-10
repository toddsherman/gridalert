import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { causesKnown, classifyCause, namesACause, onTheFeed, shareExplained, utilityEvidence, withKnownCauses } from './utility.ts';

const AT = '2026-11-01T18:00:00.000Z';

describe('classifyCause', () => {
  const cases: Array<[string, string]> = [
    ['Pending Investigation', 'pending'],
    ['Under Investigation', 'pending'],
    ['Not yet determined', 'pending'],
    ['Analyzing Problem', 'pending'],
    ['PATROLLING', 'pending'],
    ['Unplanned', 'pending'],
    ['Current Outage', 'pending'],
    ['-NDA-', 'pending'],
    ['[object Object]', 'pending'],
    ['', 'pending'],
    ['Planned Construction', 'planned'],
    ['Preventive Maintenance', 'planned'],
    ['PSPS', 'planned'],
    ['Storm/Weather', 'weather'],
    ['Tree Contact', 'tree'],
    ['Palm Frond', 'tree'],
    ['Animal', 'wildlife'],
    ['Vehicle accident', 'third-party'],
    ['THRD PARTY', 'third-party'],
    ['Balloon', 'third-party'],
    ['Equipment Problems', 'equipment'],
    ['Power Line Damaged', 'equipment'],
    ['REPLCE TXFMR', 'equipment'],
    ['Something else entirely', 'other'],
  ];
  for (const [text, category] of cases) {
    it(`reads "${text}" as ${category}`, () => assert.equal(classifyCause(text), category));
  }
});

describe('utilityEvidence', () => {
  it('accepts weather that covers most listed customers', () => {
    const e = utilityEvidence([{ cause: 'Storm/Weather', customers: 8000 }, { cause: 'Pending Investigation', customers: 2000 }], 10_000, AT);
    assert.equal(e?.strong, true);
    assert.match(e!.label, /Storm\/Weather for 80%/);
  });

  it('says nothing while most customers are still pending', () => {
    assert.equal(utilityEvidence([{ cause: 'Pending Investigation', customers: 7000 }, { cause: 'Storm/Weather', customers: 3000 }], 10_000, AT), null);
  });

  it('says nothing when the map shows too little of the blackout', () => {
    assert.equal(utilityEvidence([{ cause: 'Storm/Weather', customers: 1000 }], 10_000, AT), null);
  });

  it('accepts a local cause on a small outage', () => {
    assert.equal(utilityEvidence([{ cause: 'Vehicle accident', customers: 9000 }], 10_000, AT)?.strong, true);
  });

  it('keeps a local cause as context on a large blackout', () => {
    assert.equal(utilityEvidence([{ cause: 'Equipment Problems', customers: 90_000 }], 100_000, AT)?.strong, false);
  });

  it('takes weather on a large blackout only when a weather source agrees', () => {
    assert.equal(utilityEvidence([{ cause: 'Storm/Weather', customers: 90_000 }], 100_000, AT)?.strong, false);
    assert.equal(utilityEvidence([{ cause: 'Storm/Weather', customers: 90_000 }], 100_000, AT, true)?.strong, true);
  });

  it('does the same for a planned cut, the other label that could end the checks', () => {
    assert.equal(utilityEvidence([{ cause: 'Planned', customers: 90_000 }], 100_000, AT)?.strong, false);
    assert.equal(utilityEvidence([{ cause: 'Planned', customers: 90_000 }], 100_000, AT, true)?.strong, true);
  });

  it('keeps a local cause as context even if there is weather about', () => {
    assert.equal(utilityEvidence([{ cause: 'Equipment Problems', customers: 90_000 }], 100_000, AT, true)?.strong, false);
  });
});

describe('what is known to explain a blackout', () => {
  const storm = { id: 's', kind: 'weather', strong: true, label: 'Severe Thunderstorm Warning, Harris, TX', source: 'NWS', at: AT } as const;
  const advisory = { ...storm, id: 'w', strong: false, label: 'Wind Advisory, Harris, TX' };
  const label = { ...storm, id: 'u', kind: 'utility', label: 'Utility map says Storm for 80% of listed customers' } as const;
  const balloons = { cause: 'Metallic Balloons in Equipment', customers: 437 };

  it('tells a named cause from one that is still being worked out', () => {
    assert.ok(namesACause('Metallic Balloons in Equipment'));
    for (const text of ['Analyzing Problem', 'Pending Investigation', 'Unknown', '']) assert.ok(!namesACause(text), text);
  });

  it('keeps a cause at the most customers it reached, so fixing an outage does not unexplain it', () => {
    const before = withKnownCauses([], [balloons, { cause: 'Analyzing Problem', customers: 358 }]);
    assert.deepEqual(before, [balloons]);
    assert.deepEqual(withKnownCauses(before, [{ cause: balloons.cause, customers: 12 }]), [balloons]);
    assert.equal(withKnownCauses(before, [{ cause: balloons.cause, customers: 900 }])[0].customers, 900);
  });

  it('drops a stored label that turned out to say nothing', () => {
    assert.deepEqual(withKnownCauses([{ cause: '[object Object]', customers: 5 }, balloons], []), [balloons]);
  });

  it('counts a storm in the area as explaining all of it', () => {
    assert.equal(shareExplained({ evidence: [storm], peakCustomers: 5_000 }), 1);
  });

  it('counts a utility only for the customers it names', () => {
    assert.equal(shareExplained({ evidence: [], knownCauses: [{ cause: 'Vehicle', customers: 1_000 }], peakCustomers: 5_000 }), 0.2);
    assert.equal(shareExplained({ evidence: [label], knownCauses: [{ cause: 'Storm', customers: 4_000 }], peakCustomers: 5_000 }), 0.8);
  });

  it('counts nothing for context, and never passes 100%', () => {
    assert.equal(shareExplained({ evidence: [advisory], peakCustomers: 5_000 }), 0);
    assert.equal(shareExplained({ evidence: [], knownCauses: [{ cause: 'Storm', customers: 9_000 }], peakCustomers: 5_000 }), 1);
  });

  it('lists only causes, never context or what was ruled out', () => {
    assert.deepEqual(causesKnown({ evidence: [storm, advisory, label], knownCauses: [balloons] }), ['Severe Thunderstorm Warning, Harris, TX', 'Metallic Balloons in Equipment (437)']);
    assert.deepEqual(causesKnown({ evidence: [advisory] }), []);
  });
});

describe('the feed', () => {
  it('shows what is going on and not accounted for, including what is still being checked', () => {
    assert.ok(onTheFeed({ cause: 'unknown' }));
    assert.ok(onTheFeed({ cause: 'checking' }));
  });

  it('leaves out anything explained or over', () => {
    assert.ok(!onTheFeed({ cause: 'explained' }));
    assert.ok(!onTheFeed({ cause: 'unknown', resolvedAt: AT }));
  });
});
