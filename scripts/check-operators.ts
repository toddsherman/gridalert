// Read every grid operator's notices now and show what each one has. Writes nothing.
//
// usage: node scripts/check-operators.ts
import { OPERATOR_NAMES, readNotices } from '../lib/causes/operators.ts';

const now = new Date();
for (const operator of Object.keys(OPERATOR_NAMES)) {
  const started = Date.now();
  try {
    const notices = await readNotices(operator, now);
    console.log(`${OPERATOR_NAMES[operator].padEnd(22)} ok   ${String(notices.length).padStart(3)} notices  ${Date.now() - started} ms`);
    for (const n of notices.slice(0, 6)) console.log(`  ${n.level.padEnd(9)} ${new Date(n.start).toISOString().slice(0, 16)} to ${new Date(n.end).toISOString().slice(0, 16)}  ${n.title} [${n.states.join(' ')}]`);
  } catch (err) {
    console.log(`${OPERATOR_NAMES[operator].padEnd(22)} FAILED ${(err as Error).message}`);
  }
}
