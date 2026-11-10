import { isCountyName, resolveCounty } from './geo.ts';
import { resolveTown, resolveZip } from './local-geo.ts';
import { countiesOf, utilityByEia } from './registry.ts';
import type { AreaPlace, Source } from './sources/types.ts';

export function statesFor(source: Source): string[] {
  const states = new Set<string>();
  for (const id of source.eiaIds) for (const st of utilityByEia.get(id)?.states ?? []) states.add(st);
  return [...states];
}

/** Metros a source touches, per EIA territory or the source's own override. */
export function metrosFor(source: Source): string[] {
  if (source.metros) return source.metros;
  const out = new Set<string>();
  for (const id of source.eiaIds) for (const c of utilityByEia.get(id)?.metros ?? []) out.add(c);
  return [...out];
}

/** A function that finds the county for an area a feed names, as far as that can be told. */
export function placer(source: Source) {
  const fallback = statesFor(source);
  const territory = new Set(source.eiaIds.flatMap(countiesOf));
  return (area: AreaPlace): string | undefined => {
    const states = area.state ? [area.state] : fallback;
    if (area.kind === 'zip') return resolveZip(area.name);
    if (area.kind === 'city') return resolveTown(area.name, states, territory);
    // A county name that can't be settled stays unplaced, rather than becoming a town that shares it.
    return resolveCounty(area.name, states, territory) ?? (isCountyName(area.name, states) ? undefined : resolveTown(area.name, states, territory));
  };
}
