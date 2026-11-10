import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { levelOf, operatorsFor, parseCaiso, parseIsoNe, parseMiso, parseNyiso, parsePjm, parseSpp } from './operators.ts';

const NOW = Date.UTC(2026, 10, 1, 18);

describe('levelOf', () => {
  it('finds an order to cut power', () => {
    for (const title of ['Load Shed Directive', 'Manual Load Dump Action - Capacity Emergency - NERC EEA 3', 'Rotating outages', 'OP-7 in effect', 'Shed firm load']) assert.equal(levelOf(title), 'cut', title);
  });

  it('finds an emergency, which falls short of an order', () => {
    for (const title of ['Manual Load Dump Warning - Capacity Emergency - NERC EEA 3', 'Max Gen Event - Step 1b', 'Maximum Generation Event Step 1 (EEA 1)', 'Maximum Generation Emergency/Load Management Alert-Capacity Emergency-NERC EEA 1', 'Transmission Emergency', 'OP4 Action 1, Power Caution', 'East BAA: Energy Emergency Alert Level 1', 'EEA 2']) assert.equal(levelOf(title), 'emergency', title);
  });

  it('ignores the routine notices that make up nearly all of these feeds', () => {
    for (const title of ['Load Pocket Advisory Declaration', 'Capacity Advisory Declaration', 'Conservative Operations Declaration', 'Maximum Generation Warning', 'Max Gen Alert', 'Hot Weather Alert', 'Geomagnetic Disturbance Warning', 'M/LCC 2, Abnormal Conditions', 'Flex Alert', 'EEA Watch', 'Minimum Generation Emergency Declaration']) assert.equal(levelOf(title), null, title);
  });

  it('ignores the end of one', () => {
    assert.equal(levelOf('Max Gen Event - Step 1b termination: effective 06/23/2025 21:59 EST'), null);
  });
});

describe('parseMiso', () => {
  const notification = (subject: string, body: string) => ({ notifications: [{ subject, body, publishDateUnformatted: '2025-06-23T09:15:00+00:00', permanentLinkUrl: '/x/?id=1' }] });

  it('reads an emergency with its times and regions', () => {
    const [n] = parseMiso([notification('New Declaration: Max Gen Event - Step 1b', 'MISO has declared a Max Gen Event - Step 1b effective starting 06/23/2025 16:00 EST until 06/23/2025 22:00 EST.<br><br>Affected Region(s): Central Region, North Region - AMRN, BREC, NIPS')]);
    assert.equal(n.title, 'Max Gen Event - Step 1b');
    assert.equal(n.level, 'emergency');
    assert.equal(new Date(n.start).toISOString(), '2025-06-23T21:00:00.000Z');
    assert.equal(new Date(n.end).toISOString(), '2025-06-24T03:00:00.000Z');
    assert.ok(n.states.includes('IL') && n.states.includes('MN'));
    assert.ok(!n.states.includes('LA'));
    assert.equal(n.url, 'https://www.misoenergy.org/x/?id=1');
  });

  it('skips an advisory', () => {
    const body = 'MISO has issued a Load Pocket Advisory Declaration for Amite South due to:<br>&nbsp;Reason<br><br>Start: 11/02/2026 10:00 EST<br>End: 11/02/2026 23:00 EST<br><br>Affected Region(s):<br>&nbsp;&nbsp; South Region - EES, CLEC, LEPA, LAGT';
    assert.deepEqual(parseMiso([notification('Load Pocket Advisory Declaration', body)]), []);
  });

  it('reads the newer layout, with regions on their own line', () => {
    const body = 'Start: 11/02/2026 10:00 EST<br>End: 11/02/2026 23:00 EST<br><br>Affected Region(s):<br>&nbsp;&nbsp; South Region - EES, CLEC<br><br>This public notification is for awareness only.';
    const [n] = parseMiso([notification('Updated: Maximum Generation Event Step 1 (EEA 1)', body)]);
    assert.equal(n.title, 'Maximum Generation Event Step 1 (EEA 1)');
    assert.deepEqual(n.states, ['AR', 'LA', 'MS', 'TX']);
  });

  it('takes EEA 3 as an order to cut only if the notice says so', () => {
    const title = 'Maximum Generation Event Step 3 (EEA 3)';
    assert.equal(parseMiso([notification(title, 'Start: 11/02/2026 10:00 EST')])[0].level, 'emergency');
    assert.equal(parseMiso([notification(title, 'Instructions:<li>Shed firm load as directed.</li>')])[0].level, 'cut');
  });

  it('does not take an earlier step as an order, whatever its instructions mention', () => {
    assert.equal(parseMiso([notification('Maximum Generation Event Step 2 (EEA 2)', 'Prepare to shed firm load if conditions worsen.')])[0].level, 'emergency');
  });

  it('dates a notice with no times from when it was posted, in Eastern Standard Time', () => {
    const [n] = parseMiso([notification('Max Gen Event - Step 2', 'No times here.')]);
    assert.equal(new Date(n.start).toISOString(), '2025-06-23T14:15:00.000Z');
    assert.deepEqual(n.states, []);
  });
});

describe('parsePjm', () => {
  const page = (rows: string) => `<tbody id="frmTable:tblPostings_data" class="ui-datatable-data">${rows}</tbody>`;
  const row = (type: string, regions: string) => `<tr data-ri="0"><td></td><td>123</td><td>Action</td><td>${type}</td><td>07.15.2025 13:00</td><td>${regions}</td><td>Message</td><td>07.15.2025 20:00</td></tr>`;

  it('reads no rows from an empty table', () => {
    assert.deepEqual(parsePjm(page('<tr class="ui-datatable-empty-message"><td colspan="8">No records found.</td></tr>'), NOW), []);
  });

  it('reads a posting in Eastern time', () => {
    const [n] = parsePjm(page(row('Load Shed Directive', 'BGE')), NOW);
    assert.equal(n.level, 'cut');
    assert.equal(new Date(n.start).toISOString(), '2025-07-15T17:00:00.000Z');
    assert.equal(new Date(n.end).toISOString(), '2025-07-16T00:00:00.000Z');
    assert.deepEqual(n.states, ['MD']);
  });

  it('treats the whole of PJM as everywhere', () => {
    assert.deepEqual(parsePjm(page(row('Manual Load Dump Action', 'PJM-RTO')), NOW)[0].states, []);
  });

  it('cannot place a region it does not know, rather than matching everywhere', () => {
    assert.deepEqual(parsePjm(page(row('Load Shed Directive', 'NEWZONE')), NOW)[0].states, ['??']);
  });

  it('skips a routine alert', () => {
    assert.equal(parsePjm(page(row('Hot Weather Alert', 'PJM-RTO')), NOW).length, 0);
  });
});

describe('parseSpp', () => {
  it('reads nothing while conditions are normal', () => {
    assert.deepEqual(parseSpp('<h3>East BAA: Baseline Normal Operating Conditions</h3>\n<h3>West BAA: Resource Advisory</h3>', NOW), []);
  });

  it('reads an emergency in one area', () => {
    const [n] = parseSpp('<h3>East BAA: Energy Emergency Alert Level 2</h3>', NOW);
    assert.equal(n.title, 'East BAA: Energy Emergency Alert Level 2');
    assert.equal(n.level, 'emergency');
    assert.equal(n.start, NOW);
  });
});

describe('parseIsoNe', () => {
  const row = (condition: string, end = '06/24/2025  9:00:00 PM') => `<tr>
    <td>NEW ENGLAND</td>
    <td class="tooltip" title="testing tooltip">${condition}
      <span class="tooltip-text" style="display:none">ISO New England is declaring an Energy Emergency Alert (EEA) Level 1.<br><br>Learn more: www.iso-ne.com/status</span>
    </td>
    <td>
      06/24/2025  5:22:00 PM
    </td>
    <td>
      ${end}
    </td>
  </tr>`;

  it('reads a real row', () => {
    const [n] = parseIsoNe(row('OP4 Action 2'), NOW, 'u');
    assert.equal(n.title, 'OP4 Action 2');
    assert.equal(n.level, 'emergency');
    assert.equal(new Date(n.start).toISOString(), '2025-06-24T21:22:00.000Z');
    assert.equal(new Date(n.end).toISOString(), '2025-06-25T01:00:00.000Z');
    assert.deepEqual(n.states, []);
  });

  it('judges a row by its condition, not the explanation beside it', () => {
    assert.deepEqual(parseIsoNe(row('M/LCC 2, Abnormal Conditions'), NOW, 'u'), []);
  });

  it('keeps one still in force open until now', () => {
    assert.equal(parseIsoNe(row('OP4 Action 2', ''), NOW, 'u')[0].end, NOW);
  });
});

describe('parseNyiso', () => {
  it('reads nothing on a normal day', () => {
    assert.deepEqual(parseNyiso('Timestamp,Message\n11/01/2026 00:00:00,Start of day system state is NORMAL\n'), []);
  });

  it('reads an emergency in Eastern time, summer and winter', () => {
    const csv = 'Timestamp,Message\n07/01/2025 12:00:00,System state is MAJOR EMERGENCY\n"12/01/2025 12:00:00","Load shed ordered"\n';
    const [summer, winter] = parseNyiso(csv);
    assert.equal(summer.level, 'emergency');
    assert.equal(new Date(summer.start).toISOString(), '2025-07-01T16:00:00.000Z');
    assert.equal(winter.level, 'cut');
    assert.equal(new Date(winter.start).toISOString(), '2025-12-01T17:00:00.000Z');
  });
});

describe('parseCaiso', () => {
  it('reads nothing while the grid is normal', () => {
    assert.deepEqual(parseCaiso({ CurrentEvents: [] }, NOW), []);
  });

  it('finds the title and times in whatever fields an event has', () => {
    const [n] = parseCaiso({ CurrentEvents: [{ Id: 7, Name: 'EEA 2', StartDate: '2025-07-01T16:00:00', EndDate: '2025-07-01T21:00:00' }] }, NOW);
    assert.equal(n.title, 'EEA 2');
    assert.equal(n.level, 'emergency');
    assert.equal(new Date(n.start).toISOString(), '2025-07-01T23:00:00.000Z');
    assert.equal(new Date(n.end).toISOString(), '2025-07-02T04:00:00.000Z');
  });

  it('skips a Flex Alert', () => {
    assert.deepEqual(parseCaiso({ CurrentEvents: [{ Name: 'Flex Alert' }] }, NOW), []);
  });
});

describe('operatorsFor', () => {
  it('finds the operator for a utility in a state', () => {
    assert.deepEqual(operatorsFor(13478, 'LA'), ['MISO']);
  });

  it('finds none where a utility runs its own grid', () => {
    assert.deepEqual(operatorsFor(11208, 'CA'), []);
  });
});

describe('a link from MISO', () => {
  const notice = (permanentLinkUrl: string) => parseMiso([{ notifications: [{ subject: 'Load Shed Declaration', body: '', publishDateUnformatted: '2026-11-01T12:00:00+00:00', permanentLinkUrl }] }])[0].url;

  it('stays on its site, whatever the feed sends', () => {
    assert.equal(new URL(notice('/notifications/?id=1')).host, 'www.misoenergy.org');
    assert.equal(new URL(notice('https://evil.example/x')).host, 'www.misoenergy.org');
    assert.equal(new URL(notice('@evil.example/x')).host, 'www.misoenergy.org');
  });
});

describe('which region a notice covers', () => {
  const miso = (region: string) => parseMiso([{ notifications: [{ subject: 'Max Gen Emergency Event Step 2', body: `Affected Region(s): ${region}\n`, publishDateUnformatted: '2026-11-01T12:00:00+00:00' }] }])[0].states;

  it('puts Detroit in MISO Central, and the upper peninsula in North', () => {
    assert.ok(miso('Central Region - ITC, METC').includes('MI'));
    assert.ok(miso('North Region').includes('MI'));
    assert.ok(!miso('South Region - EES').includes('MI'));
  });

  it('keeps a notice for SPP West off the utilities in East', () => {
    const [west] = parseSpp('<h3>West BAA: Energy Emergency Alert Level 3</h3>', 0);
    const [east] = parseSpp('<h3>East BAA: Energy Emergency Alert Level 3</h3>', 0);
    assert.ok(west.states.length && !west.states.includes('KS'));
    assert.deepEqual(east.states, []);
  });

  it('includes western Pennsylvania in the ATSI zone', () => {
    const row = (zone: string) => `<table><tbody id="frmTable:tblPostings_data" class="x"><tr><td>h</td><td>1</td><td>p</td><td>Load Shed Directive</td><td>11.01.2026 12:00</td><td>${zone}</td><td>m</td><td></td></tr></tbody></table>`;
    assert.deepEqual(parsePjm(row('FE-ATSI'), 0)[0].states, ['OH', 'PA']);
  });
});
