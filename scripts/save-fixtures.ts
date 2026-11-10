// Save a small real response from each outside service to lib/fixtures, for lib/fixtures.test.ts.
// Each is cut down to a few rows, keeping the parts its reader depends on.
// usage: node scripts/save-fixtures.ts
import fs from 'node:fs';
import { sources } from '../lib/registry.ts';

const OUT = 'lib/fixtures';
const UA = { 'user-agent': 'GridAlert/1.0 (public outage monitor)' };
const text = async (url: string, headers = {}) => {
  const res = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
};
const json = async (url: string, headers = {}) => JSON.parse(await text(url, headers));
const save = (name: string, body: unknown) => {
  const out = typeof body === 'string' ? body : JSON.stringify(body);
  fs.writeFileSync(`${OUT}/${name}`, out);
  console.log(name.padEnd(24), out.length);
};
fs.mkdirSync(OUT, { recursive: true });

const nws = await json('https://api.weather.gov/alerts/active?status=actual', { accept: 'application/geo+json' });
save('nws.json', { ...nws, features: nws.features.slice(0, 3), pagination: undefined });
save('spc.csv', (await text('https://www.spc.noaa.gov/climo/reports/yesterday_filtered.csv')).split('\n').slice(0, 12).join('\n'));
save('metar.json', (await json('https://aviationweather.gov/api/data/metar?ids=KJFK,KORD&format=json&hours=1')).slice(0, 2));
const wfigs = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query';
const fires = await json(`${wfigs}?${new URLSearchParams({ where: '1=1', outFields: 'IncidentName,POOFips,IncidentSize,FireDiscoveryDateTime', returnGeometry: 'false', f: 'json', resultRecordCount: '2' })}`);
save('wfigs.json', fires);
const usgs = await json('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson');
save('usgs.json', { ...usgs, features: usgs.features.slice(0, 2) });
save('kp.json', (await json('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json')).slice(-3));

const miso = await json('https://www.misoenergy.org/api/topicnotifications/GetGroupedNotifications?topic=RealTime&take=100');
save('miso.json', miso.slice(0, 1).map((g: any) => ({ ...g, notifications: g.notifications.slice(0, 2) })));
const pjm = await text('https://emergencyprocedures.pjm.com/ep/pages/dashboard.jsf');
const table = pjm.indexOf('frmTable:tblPostings_data');
save('pjm.html', `<html><body><tbody id="${pjm.slice(table, pjm.indexOf('</tbody>', table) + 8).slice(0, 4000)}</tbody></body></html>`);
const spp = await text('https://www.spp.org/markets-operations/current-grid-conditions/');
save('spp.html', [...spp.matchAll(/<h3>(East|West) BAA:[^<]*<\/h3>/g)].map((m) => m[0]).join('\n'));
const isone = await text('https://www.iso-ne.com/markets-operations/system-forecast-status/current-system-status/power-system-status-year?year=2026');
const start = isone.indexOf('PowerSystemConditions-Table');
save('isone.html', `<table id="${isone.slice(start, start + 1500)}</table>`);
const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/New_York' }).replaceAll('-', '');
save('nyiso.csv', await text(`https://mis.nyiso.com/public/csv/RealTimeEvents/${day}RealTimeEvents.csv`));
save('caiso.json', await json('https://wwwmobile.caiso.com/TodaysOutlookApi/api/EmergencyNotices/v2/ActiveEvents'));
const cisa = await text('https://www.cisa.gov/news.xml');
save('rss.xml', `${cisa.slice(0, cisa.indexOf('<item>'))}${cisa.slice(cisa.indexOf('<item>'), cisa.indexOf('</item>') + 7)}</channel></rss>`);

const odin = await json('https://ornl.opendatasoft.com/api/explore/v2.1/catalog/datasets/odin-real-time-outages-county/exports/json?select=utility_id,name,communitydescriptor,metersaffected,reportedstarttime&limit=5&order_by=reportedstarttime%20desc');
save('odin.json', odin);

const kubra = sources.find((s) => s.method === 'kubra')! as any;
const base = 'https://kubra.io/';
const state = await json(`${base}stormcenter/api/v1/stormcenters/${kubra.config.instanceId}/views/${kubra.config.viewId}/currentState?preview=false`);
const config = await json(`${base}stormcenter/api/v1/stormcenters/${kubra.config.instanceId}/views/${kubra.config.viewId}/configuration/${state.stormcenterDeploymentId}?preview=false`);
const summaryPath = config.config.summary.data.interval_generation_data.source;
const reportPath = config.config.reports.data.interval_generation_data[0].source;
const summary = await json(`${base}${state.data.interval_generation_data}/${summaryPath}`);
const report = await json(`${base}${state.data.interval_generation_data}/${reportPath}`);
const trimAreas = (areas: any[]): any[] => areas.slice(0, 3).map((a) => (a.areas ? { ...a, areas: trimAreas(a.areas) } : a));
save('kubra-state.json', state);
save('kubra-config.json', { config: { summary: config.config.summary, reports: { data: { interval_generation_data: config.config.reports.data.interval_generation_data.slice(0, 1) } } } });
save('kubra-summary.json', summary);
save('kubra-report.json', { ...report, file_data: { ...report.file_data, areas: trimAreas(report.file_data.areas ?? []) } });

const arcgis = sources.find((s) => s.method === 'arcgis')! as any;
const stats = [{ statisticType: 'sum', onStatisticField: arcgis.config.outField, outStatisticFieldName: 'out_sum' }, { statisticType: 'count', onStatisticField: arcgis.config.outField, outStatisticFieldName: 'n' }];
save('arcgis.json', await json(`${arcgis.config.layerUrl.replace(/\/$/, '')}/query?${new URLSearchParams({ where: arcgis.config.where ?? '1=1', outStatistics: JSON.stringify(stats), returnGeometry: 'false', f: 'json' })}`));
