export default function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <circle
        cx="32"
        cy="32"
        r="22"
        fill="none"
        strokeWidth={6}
        style={{ stroke: "var(--line)" }}
      />
      <path
        d="M32 10 A22 22 0 0 1 51 21"
        fill="none"
        stroke="#5fa5ef"
        strokeWidth={6}
        strokeLinecap="round"
      />
      <circle cx="51" cy="21" r="5" style={{ fill: "var(--ink)" }} />
    </svg>
  );
}
