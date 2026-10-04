// The Daylight landscape: pastel sky, lavender ranges, a peach field and, where
// a tree would stand, a stack of blocks — the chain the indexer climbs, its
// cursor on the path and the head at the top. Everything is drawn in SVG, so
// the site ships no images. Gradients and the grain filter are defined once in
// <SceneDefs /> and referenced by id from every scene on the page.

export function SceneDefs() {
  return (
    <svg width="0" height="0" className="defs" aria-hidden="true">
      <defs>
        <filter id="grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves={2} stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <linearGradient id="far" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c9b2db" />
          <stop offset="1" stopColor="#e9c4cc" />
        </linearGradient>
        <linearGradient id="near" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a98fcb" />
          <stop offset="1" stopColor="#d9a9bd" />
        </linearGradient>
        <linearGradient id="field" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f0b07c" />
          <stop offset="1" stopColor="#df7b45" />
        </linearGradient>
        <linearGradient id="block" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ff9a4a" />
          <stop offset="1" stopColor="#cf4418" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function Grain({ opacity = 0.2 }: { opacity?: number }) {
  return (
    <svg className="grain" aria-hidden="true">
      <rect width="100%" height="100%" filter="url(#grain)" opacity={opacity} />
    </svg>
  );
}

// Illustrative block numbers, oldest at the bottom of the stack.
const STACK = [
  { x: 662, y: 300, o: 1, n: "#24,231,535" },
  { x: 674, y: 268, o: 0.95, n: "#24,231,536" },
  { x: 654, y: 236, o: 0.9, n: "#24,231,537" },
  { x: 668, y: 204, o: 0.84, n: "#24,231,538" },
  { x: 660, y: 172, o: 0.78, n: "#24,231,539" },
  { x: 672, y: 140, o: 0.7, n: "#24,231,540" },
];

export function HeroScene() {
  return (
    <svg className="hero-scene" viewBox="0 0 1440 520" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <polygon fill="url(#far)" points="0,190 120,100 210,130 330,50 430,85 560,10 640,60 760,25 880,70 990,0 1120,60 1230,30 1340,80 1440,50 1440,280 0,280" />
      <polygon fill="url(#near)" opacity={0.9} points="0,240 90,180 180,205 300,140 420,200 520,160 640,215 780,170 900,220 1030,160 1160,215 1290,180 1440,225 1440,300 0,300" />
      <rect x="0" y="280" width="1440" height="240" fill="url(#field)" />
      <path d="M0 352 Q 360 342 720 357 T 1440 350" stroke="#6f8f6a" strokeWidth={12} fill="none" opacity={0.45} />
      <path d="M0 410 Q 420 398 760 416 T 1440 408" stroke="#6f8f6a" strokeWidth={9} fill="none" opacity={0.35} />
      <path d="M0 470 Q 380 460 740 474 T 1440 468" stroke="#6f8f6a" strokeWidth={7} fill="none" opacity={0.28} />
      <path d="M724 520 C 712 470 700 410 716 330" stroke="#f6d6b8" strokeWidth={22} fill="none" opacity={0.6} />
      {STACK.map((b) => (
        <g key={b.n}>
          <rect x={b.x} y={b.y} width="120" height="32" fill="url(#block)" opacity={b.o} />
          <text x={b.x + 14} y={b.y + 20} className="blk">
            {b.n}
          </text>
        </g>
      ))}
      <line x1="732" y1="140" x2="732" y2="112" stroke="#2f2a20" strokeWidth={1} />
      <rect x="680" y="88" width="104" height="22" rx="11" fill="rgba(255,255,255,.6)" stroke="rgba(47,42,32,.35)" />
      <text x="732" y="103" textAnchor="middle" className="tag">
        HEAD · LIVE
      </text>
      <circle cx="709" cy="430" r="4" fill="#2f2a20" />
      <line x1="709" y1="430" x2="640" y2="430" stroke="#2f2a20" strokeWidth={1} />
      <rect x="566" y="419" width="74" height="22" rx="11" fill="rgba(255,255,255,.6)" stroke="rgba(47,42,32,.35)" />
      <text x="603" y="434" textAnchor="middle" className="tag">
        _cursor
      </text>
    </svg>
  );
}

export function DistantRange() {
  return (
    <svg className="distant-range" viewBox="0 0 1440 200" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <polygon fill="url(#far)" points="0,120 140,60 260,95 400,30 520,80 660,20 780,70 920,35 1060,90 1200,40 1320,85 1440,55 1440,200 0,200" />
    </svg>
  );
}

export function RadarScene() {
  return (
    <svg className="radar-scene" viewBox="0 0 1360 220" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <polygon fill="url(#far)" points="0,110 130,40 240,80 380,10 500,60 640,0 760,55 900,20 1040,70 1180,25 1300,75 1360,50 1360,220 0,220" />
      <polygon fill="url(#near)" opacity={0.9} points="0,150 110,100 220,125 360,80 480,130 600,95 740,140 880,100 1010,145 1150,105 1280,140 1360,120 1360,220 0,220" />
      <rect x="0" y="180" width="1360" height="40" fill="url(#field)" />
    </svg>
  );
}

export function FooterScene() {
  return (
    <svg className="footer-scene" viewBox="0 0 1440 820" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <polygon fill="url(#far)" points="0,560 120,470 210,500 330,420 430,455 560,380 640,430 760,395 880,440 990,370 1120,430 1230,400 1340,450 1440,420 1440,640 0,640" />
      <polygon fill="url(#near)" opacity={0.9} points="0,600 90,540 180,565 300,500 420,560 520,520 640,575 780,530 900,580 1030,520 1160,575 1290,540 1440,585 1440,660 0,660" />
      <rect x="0" y="640" width="1440" height="180" fill="url(#field)" />
      <path d="M0 700 Q 360 690 720 705 T 1440 698" stroke="#6f8f6a" strokeWidth={10} fill="none" opacity={0.45} />
      <path d="M0 742 Q 420 730 760 748 T 1440 740" stroke="#6f8f6a" strokeWidth={7} fill="none" opacity={0.35} />
      <path d="M720 820 C 712 760 700 700 716 650" stroke="#f6d6b8" strokeWidth={18} fill="none" opacity={0.55} />
      <rect x="690" y="610" width="60" height="22" fill="url(#block)" />
      <rect x="698" y="588" width="60" height="22" fill="url(#block)" opacity={0.92} />
      <rect x="684" y="566" width="60" height="22" fill="url(#block)" opacity={0.84} />
      <rect x="694" y="544" width="60" height="22" fill="url(#block)" opacity={0.76} />
      <rect x="702" y="522" width="60" height="22" fill="url(#block)" opacity={0.66} />
    </svg>
  );
}
