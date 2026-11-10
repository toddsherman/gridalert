// Pre-render map geometry to data/map.json so pages never parse the full atlas.
import fs from 'node:fs';
import { geoPath } from 'd3-geo';
import { feature, mesh } from 'topojson-client';

const atlas = JSON.parse(fs.readFileSync('node_modules/us-atlas/counties-albers-10m.json', 'utf8'));
const metros = JSON.parse(fs.readFileSync('data/metros.json', 'utf8'));
const geo = JSON.parse(fs.readFileSync('data/geo.json', 'utf8'));
const path = geoPath().digits(1);

const counties = {};
const centroids = {};
for (const f of feature(atlas, atlas.objects.counties).features) {
  counties[f.id] = path(f);
  centroids[f.id] = path.centroid(f);
}

// Metro marker: population-weighted centroid of its counties.
const metroPoints = {};
for (const m of metros) {
  let x = 0, y = 0, w = 0;
  for (const c of m.counties) {
    const p = centroids[c.fips];
    if (!p || Number.isNaN(p[0])) continue;
    const weight = Math.max(c.population, 1);
    x += p[0] * weight; y += p[1] * weight; w += weight;
  }
  if (w) metroPoints[m.cbsa] = [Math.round(x / w), Math.round(y / w)];
}
// Connecticut metros use planning regions, which aren't in the atlas.
for (const [fips, cbsa] of Object.entries(geo.metroOf)) {
  if (!metroPoints[cbsa] && centroids[fips]) metroPoints[cbsa] = centroids[fips].map(Math.round);
}

const out = {
  width: 975,
  height: 610,
  nation: path(mesh(atlas, atlas.objects.nation)),
  states: path(mesh(atlas, atlas.objects.states, (a, b) => a !== b)),
  counties,
  metroPoints,
};
fs.writeFileSync('data/map.json', JSON.stringify(out));
console.log('map.json bytes', fs.statSync('data/map.json').size, 'counties', Object.keys(counties).length, 'metro points', Object.keys(metroPoints).length, 'of', metros.length);
