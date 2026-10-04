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
      <button type="button" className="btn" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
