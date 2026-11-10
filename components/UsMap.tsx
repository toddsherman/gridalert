import { countyName } from '@/lib/geo';
import { compact, heatClass, HEAT_BINS, num, shortMetro } from '@/lib/format';
import { countyPath, MAP_HEIGHT, MAP_WIDTH, metroPoint, nationPath, statesPath } from '@/lib/map';
import type { MetroStatus } from '@/lib/types';
import { BASE_PATH } from '@/lib/site';

const LABELLED_METROS = 7;
const LABELLED_ON_PHONES = 3;

export function UsMap({ counties, metros, peoplePerCustomer }: { counties: Record<string, number>; metros: MetroStatus[]; peoplePerCustomer: number }) {
  const shapes = Object.entries(counties)
    .map(([fips, customers]) => ({ fips, customers, people: Math.round(customers * peoplePerCustomer), d: countyPath(fips) }))
    .filter((c) => c.d && c.people > 0)
    .sort((a, b) => a.people - b.people);

  return (
    <figure>
      <svg viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} role="img" aria-label="Map of US counties shaded by estimated people without power. The table of metros on this page has the same data." className="block h-auto w-full">
        <path d={nationPath} fill="var(--land)" />
        <g>
          {shapes.map((c) => (
            <path key={c.fips} d={c.d} className={`county h${heatClass(c.people)}`} data-tip={`${countyName(c.fips)}|About ${num(c.people)} people (${num(c.customers)} customers)`} />
          ))}
        </g>
        <path d={statesPath} fill="none" stroke="var(--land-line)" strokeWidth={0.75} />
        {metros.slice(0, LABELLED_METROS).map((m, i) => {
          const point = metroPoint(m.cbsa);
          if (!point) return null;
          const [x, y] = point;
          const flip = x > MAP_WIDTH - 150;
          return (
            <a key={m.cbsa} href={`${BASE_PATH}/metros/${m.cbsa}`} aria-label={`${m.name}: about ${num(m.estimatedPeople)} people`}>
              <circle cx={x} cy={y} r={Math.max(5, 11 - i)} className="metro-dot" data-tip={`${m.name}|About ${num(m.estimatedPeople)} people (${num(m.customersOut)} customers)`} />
              <text x={x + (flip ? -13 : 13)} y={y + 4} textAnchor={flip ? 'end' : 'start'} className={`metro-label${i >= LABELLED_ON_PHONES ? ' metro-label-extra' : ''}`}>
                {shortMetro(m.name)} {compact(m.estimatedPeople)}
              </text>
            </a>
          );
        })}
      </svg>
      <figcaption className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2">
        <span>Estimated people out, by county</span>
        <span className="flex flex-wrap items-center gap-3">
          {HEAT_BINS.map((edge, i) => (
            <span key={edge} className="flex items-center gap-1.5">
              <span className={`swatch-${i + 1} inline-block h-3 w-3 rounded-[3px]`} aria-hidden />
              <span className="tabular">{edge === Infinity ? `${compact(HEAT_BINS[i - 1])}+` : `< ${compact(edge)}`}</span>
            </span>
          ))}
        </span>
      </figcaption>
    </figure>
  );
}
