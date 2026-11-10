import { ImageResponse } from 'next/og';
import { Bolt } from '../../bolt';

// Next's own icon files link without the base path, which through todd.sh would load todd.sh's
// icons. These are linked by hand in the layout and the manifest instead.
const SIZES = [32, 180, 192, 512];

export const dynamic = 'force-static';

export function generateStaticParams() {
  return SIZES.map((size) => ({ size: String(size) }));
}

export async function GET(_: Request, { params }: { params: Promise<{ size: string }> }) {
  const side = Number((await params).size);
  if (!SIZES.includes(side)) return new Response('Not found', { status: 404 });
  return new ImageResponse(<Bolt side={side} />, { width: side, height: side });
}
