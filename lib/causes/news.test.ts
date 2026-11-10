import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import zlib from 'node:zlib';
import { advanceNews, gkgUrl, isAbout, type NewsArea, type NewsItem, parseGkg, parseOfficial, soundsDeliberate, unzipSingle } from './news.ts';

function gkgRow(over: { themes?: string; locations?: string; title?: string; date?: string; url?: string } = {}) {
  const c = new Array(27).fill('');
  c[1] = over.date ?? '20250525223000';
  c[3] = 'wwltv.com';
  c[4] = over.url ?? 'https://www.wwltv.com/story';
  c[7] = over.themes ?? 'MANMADE_DISASTER_POWER_OUTAGES;POWER_OUTAGE;TAX_FNCACT';
  c[9] = over.locations ?? '3#New Orleans, Louisiana, United States#US#USLA#29.9547#-90.0751#-1;2#Louisiana, United States#US#USLA#31.1801#-91.8749#LA';
  c[26] = `<PAGE_TITLE>${over.title ?? 'Entergy: 100,000 without power in New Orleans &amp; Metairie'}</PAGE_TITLE>`;
  return c.join('\t');
}

describe('gkgUrl', () => {
  it('names the 15-minute file holding a moment', () => {
    assert.equal(gkgUrl(Date.UTC(2026, 10, 2, 0, 22, 41)), 'https://storage.googleapis.com/data.gdeltproject.org/gdeltv2/20261102001500.gkg.csv.zip');
  });
});

describe('unzipSingle', () => {
  it('reads the one file in a zip', () => {
    const name = Buffer.from('a.csv');
    const body = zlib.deflateRawSync(Buffer.from('hello'));
    const header = Buffer.alloc(30);
    header.writeUInt16LE(name.length, 26);
    assert.equal(unzipSingle(Buffer.concat([header, name, body])), 'hello');
  });
});

describe('parseGkg', () => {
  it('keeps a US story tagged as a power outage', () => {
    const [item] = parseGkg(gkgRow());
    assert.equal(item.source, 'wwltv.com');
    assert.equal(item.title, 'Entergy: 100,000 without power in New Orleans & Metairie');
    assert.equal(new Date(item.at).toISOString(), '2025-05-25T22:30:00.000Z');
    assert.deepEqual(item.places, [{ name: 'New Orleans', state: 'LA', lat: 29.9547, lon: -90.0751 }]);
  });

  it('skips a story without the theme, even if the word appears elsewhere', () => {
    assert.deepEqual(parseGkg(gkgRow({ themes: 'TAX_FNCACT;ENV_WINDPOWER', title: 'POWER_OUTAGE in the title' })), []);
  });

  it('skips a story with no US city', () => {
    assert.deepEqual(parseGkg(gkgRow({ locations: '4#Lusaka, Lusaka, Zambia#ZA#ZA09#-15.4#28.3#-1' })), []);
  });

  it('skips a story with no headline', () => {
    assert.deepEqual(parseGkg(gkgRow({ title: '' })), []);
  });

  it('reads several rows', () => {
    assert.equal(parseGkg(`${gkgRow()}\n${gkgRow()}\n`).length, 2);
  });
});

describe('isAbout', () => {
  const area: NewsArea = { names: ['New Orleans', 'Metairie', 'Orleans Parish'], utilities: ['Entergy'], states: new Set(['LA']), points: [[-90.08, 29.97]] };
  const item = (title: string, places: NewsItem['places'] = []): NewsItem => ({ at: 0, source: 's', url: 'u', title, places });
  const nola = { name: 'New Orleans', state: 'LA', lat: 29.95, lon: -90.07 };
  const portland = { name: 'Portland', state: 'OR', lat: 45.5, lon: -122.6 };

  it('takes a story placed near the area', () => {
    assert.equal(isAbout(item('Thousands without power after grid emergency', [nola]), area), true);
  });

  it('takes a headline naming the area, when the story is in the same state', () => {
    assert.equal(isAbout(item('Power outage hits New Orleans', [{ name: 'Baton Rouge', state: 'LA', lat: 30.4, lon: -91.2 }]), area), true);
  });

  it('does not take a name that repeats in another state', () => {
    assert.equal(isAbout(item('Power outage in New Orleans Street, Portland', [portland]), area), false);
  });

  it('takes a headline naming the utility, wherever GDELT placed it', () => {
    assert.equal(isAbout(item('Entergy says outage is over', [portland]), area), true);
  });

  it('takes nothing off topic, even nearby', () => {
    assert.equal(isAbout(item('Saints win in overtime', [nola]), area), false);
  });
});

describe('parseOfficial', () => {
  const rss = (title: string) => `<rss><channel><title>CISA News</title><item><title>${title}</title><link>https://www.cisa.gov/x</link><pubDate>Mon, 26 Oct 26 12:00:00 +0000</pubDate></item></channel></rss>`;

  it('keeps a statement about the grid', () => {
    const [n] = parseOfficial(rss('CISA Statement on Electric Sector Incident'), 'CISA');
    assert.equal(n.source, 'CISA');
    assert.equal(n.url, 'https://www.cisa.gov/x');
    assert.equal(new Date(n.at).toISOString(), '2026-10-26T12:00:00.000Z');
  });

  it('skips everything else agencies post', () => {
    assert.deepEqual(parseOfficial(rss('CISA Adds Two Known Exploited Vulnerabilities to Catalog'), 'CISA'), []);
    assert.deepEqual(parseOfficial(rss('Hitachi Energy TRO600 series products'), 'CISA'), []);
  });

  it('reads an Atom feed', () => {
    const atom = '<feed><entry><title type="html">Engineer Sentenced for Bombings of PG&amp;E Transformers</title><link href="https://www.fbi.gov/x" rel="alternate"/><published>2025-12-17T12:00:00Z</published></entry></feed>';
    const [n] = parseOfficial(atom, 'FBI');
    assert.equal(n.title, 'Engineer Sentenced for Bombings of PG&E Transformers');
    assert.equal(n.url, 'https://www.fbi.gov/x');
  });
});

describe('soundsDeliberate', () => {
  it('flags the wording real attacks used', () => {
    for (const title of ["'Intentional Vandalism' Leaves 40,000 Without Power in N.C.", "N.C. Power Outages Investigated As 'Criminal Occurrence'", '2 power substations attacked in Washington state, over 7K lost power', 'Hackers blamed for power outage', 'Three substations targeted in Washington state', 'Russian hackers blamed for Chicago power outage', 'Iran-linked group claims attack on Texas power grid']) assert.equal(soundsDeliberate(title), true, title);
  });

  it('leaves the ordinary alone', () => {
    for (const title of ['Thousands without power after storm', 'Transformer fire knocks out power', 'Car crash cuts power to 3,000', 'Planned outage in Tracy']) assert.equal(soundsDeliberate(title), false, title);
  });

  it('leaves out wars abroad and other kinds of attack', () => {
    for (const title of ['Ukraine extends blackouts as Russian attacks continue', 'Man has heart attack during power outage', 'Gaza without power after strikes and attacks']) assert.equal(soundsDeliberate(title), false, title);
  });
});

describe('advanceNews', () => {
  const realFetch = globalThis.fetch;
  const LATEST = Date.UTC(2026, 10, 2, 0, 15);
  const NOW = new Date(LATEST + 300_000);
  const index = (at: number) => `1 x http://data.gdeltproject.org/gdeltv2/20261102001500.export.CSV.zip\n2 y ${gkgUrl(at).replace('https://storage.googleapis.com/', 'http://')}\n`;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function serve(rows: string, missing: number[] = [], status = 404) {
    const name = Buffer.from('a.csv');
    const header = Buffer.alloc(30);
    header.writeUInt16LE(name.length, 26);
    const zip = Buffer.concat([header, name, zlib.deflateRawSync(Buffer.from(rows))]);
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(url);
      if (url.endsWith('lastupdate.txt')) return new Response(index(LATEST));
      if (missing.some((at) => url === gkgUrl(at))) return new Response('', { status });
      if (url.endsWith('.zip')) return new Response(zip);
      return new Response('<rss></rss>');
    }) as unknown as typeof fetch;
    return asked;
  }

  it('reads nothing until GDELT publishes something new', async () => {
    const asked = serve(gkgRow());
    const log = { through: LATEST, items: [] };
    assert.equal(await advanceNews(log, NOW), log);
    assert.equal(asked.length, 1);
  });

  it('reads the newest file and remembers it', async () => {
    serve(gkgRow({ date: '20261102001500' }));
    const next = await advanceNews({ through: LATEST - 900_000, items: [] }, NOW);
    assert.equal(next.through, LATEST);
    assert.equal(next.items.length, 1);
  });

  it('waits for a file the index lists before it is up, without losing the rest', async () => {
    const before = LATEST - 900_000;
    serve(gkgRow({ date: '20261102000000' }), [LATEST]);
    const next = await advanceNews({ through: LATEST - 1_800_000, items: [] }, NOW);
    assert.equal(next.through, before, 'the newest file is tried again next poll');
    assert.equal(next.items.length, 1);
  });

  it('changes nothing if the only new file is not up yet', async () => {
    serve(gkgRow(), [LATEST]);
    const log = { through: LATEST - 900_000, items: [] };
    assert.equal(await advanceNews(log, NOW), log);
  });

  it('steps over a real gap in GDELT rather than sticking on it', async () => {
    serve(gkgRow({ date: '20261102001500' }), [LATEST - 900_000]);
    assert.equal((await advanceNews({ through: LATEST - 1_800_000, items: [] }, NOW)).through, LATEST);
  });

  it('counts any other failure as a failed read, to try again', async () => {
    serve(gkgRow(), [LATEST], 500);
    await assert.rejects(advanceNews({ through: LATEST - 900_000, items: [] }, NOW), /GDELT 500/);
  });

  it('catches up on a short gap, not an endless one', async () => {
    const asked = serve(gkgRow({ date: '20261102001500' }));
    await advanceNews({ through: 0, items: [] }, NOW);
    assert.equal(asked.filter((u) => u.endsWith('.zip')).length, 4);
  });

  it('drops a story it already has, and anything over two days old', async () => {
    serve(gkgRow({ date: '20261102001500' }));
    const old = { at: NOW.getTime() - 49 * 3_600_000, source: 's', url: 'old', title: 't', places: [] };
    const seen = { at: NOW.getTime(), source: 's', url: 'https://www.wwltv.com/story', title: 't', places: [] };
    const next = await advanceNews({ through: LATEST - 900_000, items: [old, seen] }, NOW);
    assert.deepEqual(next.items.map((i) => i.url), ['https://www.wwltv.com/story']);
  });

  it('never dates a story in the future, since files go up before their named time', async () => {
    serve(gkgRow({ date: '20261102001500' }));
    const early = new Date(LATEST - 600_000);
    assert.equal((await advanceNews({ through: LATEST - 900_000, items: [] }, early)).items[0].at, early.getTime());
  });

  it('leaves out a story whose headline is off topic', async () => {
    serve(gkgRow({ date: '20261102001500', title: 'Nine killed as jet crashes in a residential area' }));
    assert.equal((await advanceNews({ through: LATEST - 900_000, items: [] }, NOW)).items.length, 0);
  });
});

describe('bad data in the news', () => {
  it('survives an entity past the end of Unicode, which used to lose the whole file', () => {
    const items = parseGkg([gkgRow({ title: 'Thousands lose power &#99999999; tonight' }), gkgRow({ title: 'A second outage story' })].join('\n'));
    assert.equal(items.length, 2);
    assert.match(items[0].title, /&#99999999;/);
  });

  it('decodes entities written in hex, which show up raw in headlines otherwise', () => {
    assert.equal(parseGkg(gkgRow({ title: 'Power out &#x2013; thousands wait' }))[0].title, 'Power out \u2013 thousands wait');
  });

  it('skips a row it cannot read and keeps the rest', () => {
    const items = parseGkg([gkgRow({ locations: '3#Broken' }), gkgRow()].join('\n'));
    assert.equal(items.length, 1);
  });

  it('drops a story whose link is not a public web address', () => {
    assert.deepEqual(parseGkg(gkgRow({ url: 'http://169.254.169.254/latest/meta-data/' })), []);
    assert.deepEqual(parseGkg(gkgRow({ url: 'javascript:alert(1)' })), []);
  });

  it('drops an official item with a link it cannot trust', () => {
    const xml = '<rss><item><title>Attack on power grid</title><link>file:///etc/passwd</link><pubDate>Sun, 01 Nov 2026 12:00:00 GMT</pubDate></item></rss>';
    assert.deepEqual(parseOfficial(xml, 'FBI'), []);
  });

  it('refuses a zip that opens up past the limit', () => {
    const name = Buffer.from('a.csv');
    const header = Buffer.alloc(30);
    header.writeUInt16LE(name.length, 26);
    const bomb = Buffer.concat([header, name, zlib.deflateRawSync(Buffer.alloc(140 * 1024 * 1024))]);
    assert.throws(() => unzipSingle(bomb));
  });
});

describe('GDELT changing its format', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('fails on a file with the wrong columns, rather than finding no stories', async () => {
    const LATEST = Date.UTC(2026, 10, 2, 0, 15);
    const name = Buffer.from('a.csv');
    const header = Buffer.alloc(30);
    header.writeUInt16LE(name.length, 26);
    const zip = Buffer.concat([header, name, zlib.deflateRawSync(Buffer.from('a\tb\tc\n'))]);
    globalThis.fetch = (async (url: string) => (url.endsWith('lastupdate.txt') ? new Response(`1 x ${gkgUrl(LATEST)}\n`) : url.endsWith('.zip') ? new Response(zip) : new Response('<rss></rss>'))) as unknown as typeof fetch;
    await assert.rejects(advanceNews({ through: LATEST - 900_000, items: [] }, new Date(LATEST + 300_000)), /changed shape/);
  });
});

it('matches a name written without its accent', () => {
  const item = parseGkg(gkgRow({ locations: '3#Las Cruces, New Mexico, United States#US#USNM#32.3123#-106.778#919045', title: 'Power outage in Dona Ana County overnight' }))[0];
  const area: NewsArea = { names: ['Doña Ana'], utilities: [], states: new Set(['NM']), points: [[0, 0]] };
  assert.ok(isAbout(item, area));
});
