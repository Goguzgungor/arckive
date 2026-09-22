"use client";

import { useEffect, useState } from "react";

const REPO_API = "https://api.github.com/repos/Goguzgungor/arckive";

// Fetched client-side because the site is a static export. The unauthenticated
// GitHub API is rate-limited per visitor IP, so on failure we simply render the
// button without a count instead of showing a stale or zero number.
function useStarCount() {
  const [stars, setStars] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(REPO_API, { headers: { Accept: "application/vnd.github+json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d && typeof d.stargazers_count === "number") {
          setStars(d.stargazers_count);
        }
      })
      .catch(() => {
        /* offline or rate-limited — render without a count */
      });
    return () => {
      alive = false;
    };
  }, []);
  return stars;
}

export function StarIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.5l2.94 5.96 6.58.96-4.76 4.64 1.12 6.55L12 17.52l-5.88 3.09 1.12-6.55L2.48 9.42l6.58-.96L12 2.5z" />
    </svg>
  );
}

export default function StarButton({
  href,
  label = "Star on GitHub",
  className = "btn-line btn-sm",
}: {
  href: string;
  label?: string;
  className?: string;
}) {
  const stars = useStarCount();
  return (
    <a className={`${className} star-btn`} href={href} target="_blank" rel="noopener noreferrer">
      <StarIcon />
      <span>{label}</span>
      {stars !== null && (
        <span className="star-count" aria-label={`${stars} stars`}>
          {stars.toLocaleString("en-US")}
        </span>
      )}
    </a>
  );
}
