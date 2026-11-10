import assert from 'node:assert/strict';
import { it } from 'node:test';
import { countyName, isCountyName, metroForCounty, normalizeCounty, resolveCounty, resolveReportCounty, withOldCodes } from './geo.ts';

it('normalizes the spellings feeds use', () => {
  assert.equal(normalizeCounty('Prince George\'s County'), normalizeCounty("PRINCE GEORGE'S"));
  assert.equal(normalizeCounty('St. Louis'), normalizeCounty('Saint Louis'));
  assert.equal(normalizeCounty('DeKalb'), normalizeCounty('De Kalb'));
  assert.equal(normalizeCounty('Orleans Parish'), normalizeCounty('Orleans'));
  assert.equal(normalizeCounty('Doña Ana'), normalizeCounty('Dona Ana'));
});

it('maps counties to their metro', () => {
  assert.equal(metroForCounty(resolveCounty('Cook', ['IL'])!), '16980');
  assert.equal(metroForCounty(resolveCounty('Harris County', ['TX'])!), '26420');
  assert.equal(metroForCounty(resolveCounty('Los Angeles', ['CA'])!), '31080');
  assert.equal(resolveCounty('Fairfield', ['CT']), '09001');
  assert.equal(metroForCounty('09001'), '14860');
});

it('keeps independent cities distinct from same-named counties', () => {
  assert.notEqual(resolveCounty('Baltimore City', ['MD']), resolveCounty('Baltimore', ['MD']));
  assert.notEqual(resolveCounty('St. Louis City', ['MO']), resolveCounty('St. Louis', ['MO']));
  assert.equal(countyName(resolveCounty('Richmond City', ['VA'])!), 'Richmond city');
});

it('gives a bare name shared with a city to the county, which is how feeds that list both use it', () => {
  assert.equal(resolveCounty('Fairfax', ['VA']), '51059');
  assert.equal(resolveCounty('Richmond', ['VA']), '51159');
});

it('refuses a name that is ambiguous across a utility\'s states', () => {
  assert.equal(resolveCounty('Washington', ['MD', 'PA']), undefined);
  assert.equal(resolveCounty('Washington', ['MD']), '24043');
});

it('settles an ambiguous name with the utility\'s territory', () => {
  assert.equal(resolveCounty('JACKSON', ['KS', 'MO'], new Set(['29095'])), '29095');
  assert.equal(resolveCounty('JACKSON', ['KS', 'MO'], new Set(['29095', '20085'])), undefined);
});

it('expands abbreviated directions', () => {
  assert.equal(resolveCounty('E. BATON ROUGE', ['LA']), resolveCounty('East Baton Rouge Parish', ['LA']));
  assert.equal(resolveCounty('W. Feliciana', ['LA']), resolveCounty('West Feliciana', ['LA']));
});

it('finds the old county codes that storm feeds use for Connecticut', () => {
  assert.deepEqual(withOldCodes('09110'), ['09110', '09003', '09013']);
  assert.deepEqual(withOldCodes('48201'), ['48201']);
});

it('keeps a county and a city of the same name apart', () => {
  for (const [county, city, name, state] of [['51161', '51770', 'Roanoke', 'VA'], ['51159', '51760', 'Richmond', 'VA'], ['51059', '51600', 'Fairfax', 'VA'], ['24005', '24510', 'Baltimore', 'MD'], ['29189', '29510', 'St. Louis', 'MO']]) {
    assert.equal(resolveCounty(name, [state]), county, name);
    assert.equal(resolveCounty(`${name} City`, [state]), city, `${name} City`);
  }
});

it('reads the other ways places get written', () => {
  assert.equal(resolveCounty('City of St. Louis', ['MO']), '29510');
  assert.equal(resolveCounty('City of Suffolk', ['VA']), '51800');
  assert.equal(resolveCounty('Washington', ['DC']), '11001');
  assert.equal(resolveCounty('Vermillion', ['LA']), '22113');
});

it('finds the counties in storm reports, which cut long names short', () => {
  assert.equal(resolveReportCounty('District of Colum', 'DC'), '11001');
  assert.equal(resolveReportCounty('City of Falls Chu', 'VA'), '51610');
  assert.equal(resolveReportCounty('City of Chesapeak', 'VA'), '51550');
  assert.equal(resolveReportCounty('City of Suffolk', 'VA'), '51800');
  assert.equal(resolveReportCounty('HARRIS', 'TX'), '48201');
});

it('does not guess at a marine zone or a short name that matches nothing', () => {
  assert.equal(resolveReportCounty('ANZ536', 'MD'), undefined);
  assert.equal(resolveReportCounty('Nowhere In Partic', 'TX'), undefined);
});

it('knows a county name even when it can not say which county', () => {
  assert.ok(isCountyName('Rockingham', ['VA', 'NC']));
  assert.ok(!isCountyName('Jonesborough', ['TN']));
});
