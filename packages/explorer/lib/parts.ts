// A sentence as data: plain text, a bold run, or an address (rendered as its
// name or short form, linked to its page). Pages render it; tests read it.
export type Part = string | { b: string } | { addr: string };
