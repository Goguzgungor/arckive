// Amounts arrive as integer strings in a token's smallest unit (native USDC:
// 18 decimals) and never pass through a float: above 2^53 wei (0.009 USDC) a
// float drops digits, and the explorer shows sums of millions of them.

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export function unitsToDecimal(raw: string | bigint, decimals = 18): string {
  let v = typeof raw === 'bigint' ? raw : BigInt(raw);
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const frac = decimals ? (v % base).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${v / base}${frac ? `.${frac}` : ''}`;
}

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// [negative, |value| scaled by 10^places rounded half up, nonzero]
function scaled(dec: string, places: number): [boolean, bigint, boolean] {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(dec.trim());
  if (!m) throw new RangeError(`not a decimal: ${dec}`);
  const int = m[2]!;
  const frac = m[3] ?? '';
  let v = BigInt(int + (frac + '0'.repeat(places)).slice(0, places));
  if ((frac[places] ?? '0') >= '5') v += 1n;
  const nonzero = /[1-9]/.test(int + frac);
  return [m[1] === '-' && nonzero, v, nonzero];
}

// Two decimals with thousands separators; "<0.01" for a nonzero amount under a cent.
export function fmtAmount(dec: string): string {
  const [neg, cents, nonzero] = scaled(dec, 2);
  const sign = neg ? '−' : '';
  if (cents === 0n) return nonzero ? `${sign}<0.01` : '0.00';
  return `${sign}${group((cents / 100n).toString())}.${(cents % 100n).toString().padStart(2, '0')}`;
}

export function fmtWhole(dec: string): string {
  const [neg, units] = scaled(dec, 0);
  return `${neg && units > 0n ? '−' : ''}${group(units.toString())}`;
}

export function fmtSigned(dec: string): string {
  const [neg, , nonzero] = scaled(dec, 2);
  if (!nonzero) return '0.00';
  return neg ? fmtAmount(dec) : `+${fmtAmount(dec)}`;
}

export function fmtInt(n: number | bigint | string): string {
  const s = String(n);
  return s.startsWith('-') ? `−${group(s.slice(1))}` : group(s);
}

// v4 fees are in hundredths of a basis point: 2500 = 0.25%.
export function fmtFee(fee: number): string {
  return `${(fee / 10_000).toFixed(2)}%`;
}

export function pct(part: number, total: number): number {
  return total > 0 ? Math.round((100 * part) / total) : 0;
}

const iso = (unix: number): string => new Date(unix * 1000).toISOString();
export const fmtTime = (unix: number): string => iso(unix).slice(11, 19);
export const fmtDateTime = (unix: number): string => `${iso(unix).slice(0, 10)} ${fmtTime(unix)} UTC`;
export const fmtStamp = (unix: number): string => `${iso(unix).slice(0, 10)} ${iso(unix).slice(11, 16)}`;
export const dayOf = (unix: number): string => iso(unix).slice(0, 10);

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function fmtDateLong(d: Date): string {
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// 'YYYY-MM-DD' → '3 June 2026'
export function fmtDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export const shortAddr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const shortHash = (h: string): string => `${h.slice(0, 10)}…${h.slice(-6)}`;

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kB`;
  return `${n} B`;
}
