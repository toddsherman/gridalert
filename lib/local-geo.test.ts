import assert from 'node:assert/strict';
import { it } from 'node:test';
import { metroForCounty } from './geo.ts';
import { normalizeTown, resolveTown, resolveZip } from './local-geo.ts';

it('normalizes the ways feeds name a town', () => {
  for (const name of ['Brookline', 'BROOKLINE', 'Town of Brookline', 'Brookline town']) {
    assert.equal(normalizeTown(name), 'brookline');
  }
  assert.equal(normalizeTown('Mt. Laurel Twp'), normalizeTown('Mount Laurel township'));
  assert.equal(normalizeTown('St. Paul city'), normalizeTown('Saint Paul'));
  assert.equal(normalizeTown('Philadelphia city (balance)'), 'philadelphia');
});

it('places New England towns, which report no county', () => {
  assert.equal(metroForCounty(resolveTown('Cambridge', ['MA'])!), '14460');
  assert.equal(metroForCounty(resolveTown('Stamford', ['CT'])!), '14860');
  assert.equal(metroForCounty(resolveTown('Nashua', ['NH'])!), '31700');
});

it('uses territory to settle a repeated town name', () => {
  assert.equal(resolveTown('Washington', ['PA']), undefined);
  assert.equal(resolveTown('Washington Township', ['PA'], new Set(['42129'])), '42129');
});

it('keeps a repeated name when every match is in one metro', () => {
  const fips = resolveTown('Union', ['NJ'], new Set(['34039', '34035']));
  if (fips) assert.equal(metroForCounty(fips), '35620');
});

it('maps ZIPs to the county holding most of their land', () => {
  assert.equal(resolveZip('60601'), '17031');
  assert.equal(resolveZip('10001'), '36061');
  assert.equal(resolveZip('77002-1234'), '48201');
  assert.equal(resolveZip('00000'), undefined);
});
