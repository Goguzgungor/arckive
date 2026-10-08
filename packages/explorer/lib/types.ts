// What /api/stream sends and the pages pass to client components.

export interface Move {
  tx: string; // 0x… transaction hash
  li: number; // log index
  from: string; // 0x… lowercase
  to: string;
  fromName?: string;
  toName?: string;
  value: string; // USDC as an exact decimal string
  lane: string | null; // null: released before its lane was read
}

export interface BlockMsg {
  n: number; // block number, also the SSE id
  t: number; // block time, unix seconds
  moves: Move[];
}

export interface Largest extends Move {
  n: number;
  t: number;
}

export interface StatsMsg {
  count: number;
  usdc: string; // exact decimal
  perSec: number;
  lanes: Record<string, number>;
  largest: Largest[];
  now: number; // server clock, ms — the browser's offset for "n s behind"
}

export interface Hello {
  blocks: BlockMsg[];
  stats: StatsMsg | null;
}

export type LaneState =
  | { kind: 'read'; lane: string; p: number | null; ruled: boolean; sentence: string; why: string }
  | { kind: 'pending' } // above the insights cursor: Laya has not read it yet
  | { kind: 'before'; since: number } // older than the first lane; since = that block's time
  | { kind: 'none' } // inside the read range but without a lane
  | { kind: 'off' }; // lanes are not read on this archive
