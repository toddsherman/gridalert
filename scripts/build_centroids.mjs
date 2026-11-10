// Build data/county-centroids.json from us-atlas: [lon, lat] per county FIPS.
// usage: node scripts/build_centroids.mjs
import fs from 'node:fs';
import { geoCentroid } from 'd3-geo';
import { feature } from 'topojson-client';

const topo = JSON.parse(fs.readFileSync('node_modules/us-atlas/counties-10m.json', 'utf8'));
const out = {};
for (const county of feature(topo, topo.objects.counties).features) {
  const [lon, lat] = geoCentroid(county);
  out[county.id] = [Math.round(lon * 100) / 100, Math.round(lat * 100) / 100];
}
fs.writeFileSync('data/county-centroids.json', JSON.stringify(out));
console.log(`${Object.keys(out).length} counties`);
