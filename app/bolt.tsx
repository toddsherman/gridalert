/** The app icon: a bolt on a full-bleed square, kept inside the middle 60% so any phone's mask leaves it whole. */
export function Bolt({ side }: { side: number }) {
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#1d1c19' }}>
      <svg width={side * 0.6} height={side * 0.6} viewBox="0 0 24 24">
        <path d="M13 2 3 14h8l-1 8 10-12h-8l1-8z" fill="#f4f1ea" />
      </svg>
    </div>
  );
}
