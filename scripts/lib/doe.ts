// DOE-417 report handling shared by the backtests.
import { normalizeCounty, resolveCounty } from '../../lib/geo.ts';
import { HOUR } from './warnings.ts';

const STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', districtofcolumbia: 'DC', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', newhampshire: 'NH', newjersey: 'NJ', newmexico: 'NM', newyork: 'NY', northcarolina: 'NC',
  northdakota: 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', rhodeisland: 'RI', southcarolina: 'SC', southdakota: 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', westvirginia: 'WV', wisconsin: 'WI', wyoming: 'WY', puertorico: 'PR',
};

// Standard-time UTC offset of each state's main zone. DOE times are local.
const OFFSETS: Array<[number, string[]]> = [
  [-4, ['PR']], [-5, ['CT', 'DE', 'DC', 'FL', 'GA', 'IN', 'KY', 'ME', 'MD', 'MA', 'MI', 'NH', 'NJ', 'NY', 'NC', 'OH', 'PA', 'RI', 'SC', 'VT', 'VA', 'WV']],
  [-6, ['AL', 'AR', 'IL', 'IA', 'KS', 'LA', 'MN', 'MS', 'MO', 'NE', 'ND', 'OK', 'SD', 'TN', 'TX', 'WI']], [-7, ['AZ', 'CO', 'ID', 'MT', 'NM', 'UT', 'WY']],
  [-8, ['CA', 'NV', 'OR', 'WA']], [-9, ['AK']], [-10, ['HI']],
];
const OFFSET = new Map(OFFSETS.flatMap(([hours, list]) => list.map((st) => [st, hours] as const)));

const stateCode = (text: string) => STATES[text.toLowerCase().replace(/[^a-z]/g, '')];

export interface Report {
  date: string;
  time: string;
  area: string;
  type: string;
  customers: number;
}

/** DOE writes areas as "Texas: Harris County; Fort Bend County;" or "Harris County, Texas; ...". */
export function parseArea(text: string): { states: string[]; fips: string[] } {
  const states = new Set<string>();
  const fips = new Set<string>();
  const add = (state: string, county: string) => {
    states.add(state);
    const name = county.replace(/(?<=[a-z])(County|Parish|Borough)\b/g, ' $1').trim();
    const hit = name && normalizeCounty(name) ? resolveCounty(name, [state]) : undefined;
    if (hit) fips.add(hit);
  };
  if (text.includes(':')) {
    const parts = text.split(/([A-Za-z .]+):/);
    for (let i = 1; i < parts.length; i += 2) {
      const state = stateCode(parts[i]);
      if (!state) continue;
      states.add(state);
      for (const county of (parts[i + 1] ?? '').split(';')) add(state, county);
    }
  } else {
    for (const part of text.split(';')) {
      const comma = part.lastIndexOf(',');
      const state = stateCode(comma >= 0 ? part.slice(comma + 1) : part);
      if (state) add(state, comma >= 0 ? part.slice(0, comma) : '');
    }
  }
  return { states: [...states], fips: [...fips] };
}

export function reportStart(r: Report, state: string): number {
  const month = Number(r.date.slice(5, 7));
  const dst = state !== 'AZ' && state !== 'HI' && state !== 'PR' && month >= 4 && month <= 10;
  const offset = (OFFSET.get(state) ?? -6) + (dst ? 1 : 0);
  return Date.parse(`${r.date}T${r.time}:00Z`) - offset * HOUR;
}

export const isWeather = (type: string) => !/cyber|physical attack|vandal|sabotage/i.test(type) && /weather|natural|sever |storm|wildfire|earthquake|hurricane|tornado|\bice\b|flood|fire/i.test(type);
