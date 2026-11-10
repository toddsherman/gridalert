/**
 * Transmission towers with current running along the lines. Decoration only.
 * Towers sit every 320 units, with one off each edge so the lines run on.
 */
const TOWERS = [-240, 80, 400, 720, 1040];
const VISIBLE = TOWERS.slice(1, -1);
/** Where each conductor hangs from a tower: arm offset and height. */
const CONDUCTORS: Array<[number, number]> = [
  [-44, 40],
  [44, 40],
  [-34, 64],
  [34, 64],
];
const SAG = 26;
const BASE = 150;

function conductor([dx, y]: [number, number]): string {
  const [first, ...rest] = TOWERS;
  let d = `M${first + dx} ${y}`;
  let prev = first;
  for (const x of rest) {
    d += ` Q${(prev + x) / 2 + dx} ${y + SAG * 2} ${x + dx} ${y}`;
    prev = x;
  }
  return d;
}

/** The leg's x at height y, for the lattice between the legs. */
const leg = (x: number, side: -1 | 1, y: number) => x + side * (26 - ((BASE - y) / (BASE - 22)) * 19);

function tower(x: number): string {
  const levels = [BASE, 118, 90, 66, 44];
  const zig = levels.map((y, i) => `${i ? 'L' : 'M'}${leg(x, i % 2 ? 1 : -1, y)} ${y}`).join(' ');
  const zag = levels.map((y, i) => `${i ? 'L' : 'M'}${leg(x, i % 2 ? -1 : 1, y)} ${y}`).join(' ');
  const struts = levels.slice(1).map((y) => `M${leg(x, -1, y)} ${y}H${leg(x, 1, y)}`).join(' ');
  return [
    `M${x - 26} ${BASE}L${x - 7} 22L${x} 10L${x + 7} 22L${x + 26} ${BASE}`,
    `M${x - 44} 34H${x + 44}M${x - 34} 58H${x + 34}`,
    // Insulators hang from each arm.
    `M${x - 44} 34V40M${x + 44} 34V40M${x - 34} 58V64M${x + 34} 58V64`,
    zig,
    zag,
    struts,
  ].join(' ');
}

export function Pylons({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 800 150" preserveAspectRatio="xMidYMax meet" aria-hidden className={className}>
      <g fill="none" strokeLinejoin="round">
        {CONDUCTORS.map((c) => (
          <path key={c.join()} d={conductor(c)} className="stroke-wire" strokeWidth={1.25} />
        ))}
        {/* Current on two of the lines, at different speeds so it never looks staged. */}
        <path d={conductor(CONDUCTORS[1])} pathLength={100} className="current" strokeWidth={2.5} />
        <path d={conductor(CONDUCTORS[2])} pathLength={100} className="current current-slow" strokeWidth={2.5} />
        {VISIBLE.map((x) => (
          <path key={x} d={tower(x)} className="stroke-wire" strokeWidth={1.75} />
        ))}
      </g>
    </svg>
  );
}
