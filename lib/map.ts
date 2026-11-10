import map from '../data/map.json' with { type: 'json' };

export const MAP_WIDTH = map.width;
export const MAP_HEIGHT = map.height;
export const nationPath = map.nation;
export const statesPath = map.states;

const counties = map.counties as Record<string, string>;
const metroPoints = map.metroPoints as unknown as Record<string, [number, number]>;

export const countyPath = (fips: string): string | undefined => counties[fips];
export const metroPoint = (cbsa: string): [number, number] | undefined => metroPoints[cbsa];
