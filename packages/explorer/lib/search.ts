export type SearchRoute = { href: string } | { hint: string };

export const SEARCH_HINT = 'Paste a transaction hash (0x and 64 hex characters) or an address (0x and 40).';

const TX = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

// A dynamic route segment as typed: %20 and friends decoded; a malformed
// escape is left as it is (and then fails the parse) instead of throwing.
export function decodeParam(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function parseTxHash(s: string): string | null {
  const v = s.trim().toLowerCase();
  return TX.test(v) ? v : null;
}

export function parseAddress(s: string): string | null {
  const v = s.trim().toLowerCase();
  return ADDRESS.test(v) ? v : null;
}

// No partial matching in v1: natural-language search (sub-project D) brings questions.
export function routeSearch(input: string): SearchRoute {
  const tx = parseTxHash(input);
  if (tx) return { href: `/tx/${tx}` };
  const address = parseAddress(input);
  if (address) return { href: `/address/${address}` };
  return { hint: SEARCH_HINT };
}
