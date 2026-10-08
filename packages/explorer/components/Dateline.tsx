export function Dateline({ date }: { date: string }) {
  return (
    <div className="dateline">
      <span>{date}</span>
      <span>USDC and Uniswap v4 on Arc, indexed by Arckive</span>
    </div>
  );
}
