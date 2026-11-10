import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { afterEach, describe, it } from 'node:test';
import { parseCoopReport, parsePmtilesMetadata } from './coop.ts';
import { FetchError, getJson, getText, readBody, requireCount, safeUrl, ShapeError, toCount } from './http.ts';

describe('toCount', () => {
  it('reads every way feeds publish a count', () => {
    for (const [value, count] of [[12, 12], ['1,204', 1204], [{ val: 12 }, 12], ['<5', 5], ['< 5', 5], ['0', 0], [12.6, 13], ['12.6', 13], [-3, 0]] as const) assert.equal(toCount(value), count);
  });

  it('treats text with no digits, and nothing at all, as nobody out', () => {
    for (const value of ['N/A', '-', '', null, undefined, {}]) assert.equal(toCount(value), 0);
  });

  it('refuses to guess at anything else, which used to read as a wrong number', () => {
    for (const value of ['2026-11-01', '12.5%', '10-50', '1.2K', '1 204', 'about 40']) assert.throws(() => toCount(value), ShapeError, String(value));
  });
});

describe('requireCount', () => {
  it('passes a real zero', () => {
    assert.equal(requireCount(0, 'x'), 0);
    assert.equal(requireCount({ val: 0 }, 'x'), 0);
  });

  it('throws when the field has gone, which must not read as nobody out', () => {
    for (const value of [undefined, null, {}]) assert.throws(() => requireCount(value, 'total'), /total is missing/);
  });
});

describe('readBody', () => {
  it('stops at the limit without reading the rest', async () => {
    let pulled = 0;
    const endless = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); } });
    await assert.rejects(readBody(new Response(endless), 4096), FetchError);
    assert.ok(pulled < 10);
  });

  it('counts what a gzip bomb opens up to, not what it weighs', async () => {
    const realFetch = globalThis.fetch;
    const bomb = zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024));
    assert.ok(bomb.length < 100_000);
    const server = (await import('node:http')).createServer((_, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end(bomb);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    await assert.rejects(getText(`http://127.0.0.1:${port}/`), /Response passed/);
    await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = realFetch;
  });
});

describe('reading a body', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('copes with a BOM', async () => {
    globalThis.fetch = (async () => new Response('﻿{"a":1}')) as unknown as typeof fetch;
    assert.deepEqual(await getJson('https://x.test/'), { a: 1 });
  });
});

describe('safeUrl', () => {
  it('passes public web addresses', () => {
    for (const url of ['https://apnews.com/article/x', 'http://www.wwltv.com/a?b=c']) assert.ok(safeUrl(url));
  });

  it('refuses anything else, however it is written', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'http://localhost/', 'http://127.0.0.1/', 'http://0x7f.1/', 'http://2130706433/', 'http://169.254.169.254/latest', 'http://[::1]/', 'http://metadata.google.internal/', 'http://router.local/', 'http://intranet/', 'https://user:pw@example.com/', 'not a url', '']) assert.equal(safeUrl(url), null, url);
  });
});

describe('co-op pages built to stall the parser', () => {
  it('stays fast on a page of unclosed tags', () => {
    const started = Date.now();
    parseCoopReport(`<dl>${'<dt>'.repeat(300_000)}${'<li>'.repeat(300_000)}${'<'.repeat(1_000_000)}`);
    assert.ok(Date.now() - started < 2_000);
  });

  it('still reads a normal one', () => {
    const { customersOut, areas } = parseCoopReport('<dl><dt>Blue Ridge</dt><dd><ul><li>Yancey (NC): 2</li><li>Mitchell (NC): 1,204</li></ul></dd></dl>');
    assert.equal(customersOut, 1206);
    assert.equal(areas?.[1].name, 'Mitchell');
  });

  it('refuses a map archive that opens up past the limit', () => {
    const header = Buffer.alloc(127);
    header.write('PMTiles', 0, 'ascii');
    const bomb = zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024));
    header.writeBigUInt64LE(127n, 24);
    header.writeBigUInt64LE(BigInt(bomb.length), 32);
    header[97] = 2;
    assert.throws(() => parsePmtilesMetadata(Buffer.concat([header, bomb])));
  });
});
