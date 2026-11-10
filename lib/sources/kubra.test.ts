import assert from 'node:assert/strict';
import { it } from 'node:test';
import { decodePoint, flattenReport, quadkey, readTile } from './kubra.ts';

const area = (name: string, key: string, out: number, extra: object = {}) => ({ name, key, cust_a: { val: out }, cust_s: 1000, ...extra });

it('flattens a state and county tree', () => {
  const rows = flattenReport({ areas: [{ ...area('Virginia', 'geopolitical', 5), areas: [area('Henrico', 'county', 5)] }] });
  assert.deepEqual(rows, [{ state: 'VA', name: 'Henrico', kind: 'county', customersOut: 5, customersServed: 1000 }]);
});

it('does not mistake a county named after a state for that state', () => {
  const rows = flattenReport({ areas: [{ ...area('Oklahoma', 'geopolitical', 9), areas: [area('Washington', 'county', 9)] }] });
  assert.equal(rows[0].state, 'OK');
  const flat = flattenReport([area('Washington', 'county', 3), area('Delaware', 'county', 4)]);
  assert.equal(flat[0].state, undefined);
  assert.equal(flat[1].state, undefined);
});

it('classifies area kinds', () => {
  const rows = flattenReport([area('22101', 'zip', 1), area('Boston', 'town', 1), area('East Region', 'geopolitical', 1)]);
  assert.deepEqual(rows.map((r) => r.kind), ['zip', 'city', 'region']);
});

it('stops at the county level instead of descending to towns', () => {
  const tree = { areas: [{ ...area('SOMERSET', 'county', 9), areas: [area('Bridgewater', 'muni', 4), area('Hillsborough', 'muni', 5)] }] };
  assert.deepEqual(flattenReport(tree).map((r) => [r.name, r.kind, r.customersOut]), [['SOMERSET', 'county', 9]]);
});

it('reads state, county and township trees with upper-case states', () => {
  const tree = { areas: [{ ...area('PENNSYLVANIA', 'state', 3), areas: [{ ...area('Erie', 'county', 3), areas: [area('Millcreek', 'township', 3)] }] }] };
  const [row] = flattenReport(tree);
  assert.equal(row.state, 'PA');
  assert.equal(row.name, 'Erie');
});

it('treats town-only reports as towns', () => {
  const rows = flattenReport([area('Bristol', 'muni', 1), area('Bloomfield', 'town', 1)]);
  assert.deepEqual(rows.map((r) => r.kind), ['city', 'city']);
});

it('reads legacy reports with area_name and no keys, at a set depth', () => {
  const borough = (name: string, out: number) => ({ area_name: name, cust_a: { val: out }, cust_s: 500, areas: [{ area_name: `FUZZY_${name}`, cust_a: { val: out }, cust_s: 0 }] });
  const doc = { areas: [{ cust_a: { val: 12 }, cust_s: 1000, areas: [borough('BROOKLYN', 7), borough('BRONX', 5)] }] };
  const rows = flattenReport(doc, 'NY', [], 1);
  assert.deepEqual(rows.map((r) => [r.name, r.kind, r.state, r.customersOut]), [['BROOKLYN', 'county', 'NY', 7], ['BRONX', 'county', 'NY', 5]]);
});

it('builds a quadkey for a point', () => {
  assert.equal(quadkey(-77.5, 37.5, 6), '032010');
  assert.equal(quadkey(-77.5, 37.5, 8), '03201022');
});

it('decodes a marker position to lon and lat', () => {
  assert.deepEqual(decodePoint('_p~iF~ps|U'), [-120.2, 38.5]);
});

it('tallies incidents by cause and descends into clusters', () => {
  const totals = new Map<string, number>();
  const seen = new Set<string>();
  const incident = (id: string, cause: string, customers: number) => ({ id, desc: { inc_id: id, cluster: false, cust_a: { val: customers }, cause: { 'EN-US': cause } } });
  const cluster = { id: 'c', desc: { cluster: true, cust_a: { val: 500 }, cause: null }, geom: { p: ['_p~iF~ps|U'] } };

  const children = readTile([incident('1', 'Pending Investigation', 10), incident('2', 'Pending Investigation', 5), incident('3', 'Tree Contact', 2), cluster], 9, totals, seen);

  assert.deepEqual([...totals], [['Pending Investigation', 15], ['Tree Contact', 2]]);
  assert.equal(children.length, 1);
  assert.equal(children[0].length, 11);
});

it('reads the utility code when an incident has no English label', () => {
  const totals = new Map<string, number>();
  // As TNMP's map listed them on 2026-11-02.
  const rows = [
    { id: 'a', desc: { inc_id: '1', cust_a: { val: 5 }, cause: { orig: '-NDA-' } } },
    { id: 'b', desc: { inc_id: '2', cust_a: { val: 8 }, cause: { 'EN-US': 'Maintenance', 'es-US': 'Mantenimiento', orig: 'Planned' } } },
    { id: 'c', desc: { inc_id: '3', cust_a: { val: 2 }, cause: { 'es-US': 'Viento' } } },
  ];
  readTile(rows, 9, totals, new Set());
  assert.deepEqual([...totals], [['-NDA-', 5], ['Maintenance', 8], ['', 2]]);
});

it('does not count an incident twice when two tiles show it', () => {
  const totals = new Map<string, number>();
  const seen = new Set<string>();
  const rows = [{ id: 'a', desc: { inc_id: '1', cust_a: { val: 7 }, cause: { 'EN-US': 'Wind' } } }];
  readTile(rows, 9, totals, seen);
  readTile(rows, 11, totals, seen);
  assert.equal(totals.get('Wind'), 7);
});
