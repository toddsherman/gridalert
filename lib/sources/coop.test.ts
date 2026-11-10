import assert from 'node:assert/strict';
import { it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { parseCoopReport, parsePmtilesMetadata } from './coop.ts';

const block = (name: string, rows: string) => `<dl class="outage_report"><dt><a href="http://x">${name}</a></dt><dd><span>Updated</span><p>2 member(s) affected.</p><ul>${rows}</ul></dd></dl>`;

it('reads co-ops and counties from the association report', () => {
  const html = block('French Broad EMC', '<li>Yancey (NC): 2</li><li>Mitchell (NC): 1</li>') + block('Big Co-op', '<li>Wake (NC): 1,204</li>');
  const r = parseCoopReport(html);
  assert.equal(r.customersOut, 1207);
  assert.deepEqual(r.areas?.[0], { state: 'NC', name: 'Yancey', kind: 'county', customersOut: 2 });
  assert.equal(r.areas?.[2].customersOut, 1204);
});

it('skips co-ops with their own feed so they are not counted twice', () => {
  const html = block('EnergyUnited', '<li>Alexander (NC): 50</li>') + block('Union Power Cooperative', '<li>Union (NC): 9</li>') + block('Roanoke Electric', '<li>Hertford (NC): 3</li>');
  const r = parseCoopReport(html, ['EnergyUnited', 'union power']);
  assert.equal(r.customersOut, 3);
  assert.equal(r.areas?.length, 1);
});

it('reads an empty report as zero', () => {
  assert.deepEqual(parseCoopReport(''), { customersOut: 0, areas: [] });
});

function archive(meta: object, compression: number) {
  const body = compression === 2 ? gzipSync(JSON.stringify(meta)) : Buffer.from(JSON.stringify(meta));
  const header = Buffer.alloc(127);
  header.write('PMTiles', 0, 'ascii');
  header.writeUInt8(3, 7);
  header.writeBigUInt64LE(127n, 24);
  header.writeBigUInt64LE(BigInt(body.length), 32);
  header.writeUInt8(compression, 97);
  return Buffer.concat([header, body]);
}

it('reads metadata from a PMTiles header, compressed or not', () => {
  const meta = { OverallData: { TotalCustomersImpacted: 412 } };
  assert.deepEqual(parsePmtilesMetadata(archive(meta, 2)), meta);
  assert.deepEqual(parsePmtilesMetadata(archive(meta, 1)), meta);
  assert.throws(() => parsePmtilesMetadata(Buffer.from('not an archive, certainly not one')), /not a PMTiles/);
});
