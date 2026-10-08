import { describe, expect, it } from 'vitest';
import { SEARCH_HINT, decodeParam, parseAddress, parseTxHash, routeSearch } from '../lib/search.js';

const TX = '0x9a833894c76d093d304e8e907ae79a37ddaac7753fa9855df456643eba0f015a';
const ADDR = '0x5e2928212630ccd57bc53f0df428fb678c0da2b7';

describe('routeSearch', () => {
  it('routes a transaction hash, in any case and with spaces around it', () => {
    expect(routeSearch(TX)).toEqual({ href: `/tx/${TX}` });
    expect(routeSearch(`  ${TX.toUpperCase().replace('0X', '0x')} `)).toEqual({ href: `/tx/${TX}` });
  });
  it('routes an address', () => {
    expect(routeSearch(ADDR.toUpperCase().replace('0X', '0x'))).toEqual({ href: `/address/${ADDR}` });
  });
  it('hints at anything else', () => {
    for (const s of ['', 'hello', '0x123', TX.slice(2), `${ADDR}00`, `0x${'g'.repeat(40)}`]) expect(routeSearch(s)).toEqual({ hint: SEARCH_HINT });
  });
});

describe('URL params', () => {
  it('normalises hand-typed hashes and addresses', () => {
    expect(parseTxHash(` ${TX.toUpperCase().replace('0X', '0x')}`)).toBe(TX);
    expect(parseAddress(`${ADDR.toUpperCase().replace('0X', '0x')}  `)).toBe(ADDR);
  });
  it('decodes a typed URL segment and survives a malformed one', () => {
    expect(parseAddress(decodeParam(`%20${ADDR}%20`))).toBe(ADDR);
    expect(decodeParam('%E0%A4%A')).toBe('%E0%A4%A');
    expect(parseAddress(decodeParam('%E0%A4%A'))).toBeNull();
  });
  it('refuses anything that is not one', () => {
    expect(parseTxHash(ADDR)).toBeNull();
    expect(parseAddress(TX)).toBeNull();
    expect(parseAddress(`0x${'z'.repeat(40)}`)).toBeNull();
  });
});
