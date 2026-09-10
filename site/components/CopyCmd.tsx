"use client";

import { useRef, useState } from "react";

export default function CopyCmd({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="install">
      <code>{cmd}</code>
      <button type="button" className="btn btn-sm" onClick={copy}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="11" height="11" rx="1.5" />
          <path d="M5 15V6a2 2 0 0 1 2-2h9" />
        </svg>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
