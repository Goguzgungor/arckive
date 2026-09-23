# Arc Radar — accuracy: what the wall claims, checked

Status: implemented on `feat/radar-accuracy`.
Scope: `radar/` only. It changes what the feed reads, the facts table, the sentences the
model reads, which lanes the model decides and how viewers' questions are asked. The page
changes only where it has to show these.

## Why

The request was to make the lanes and the answers to viewers' questions more accurate. The
first measurements scored the model against labels derived from the same fact table the
model reads. That is circular, so the labels themselves were audited first. The audit found
the ground truth wrong in more places than the model.

## How the truth was checked

The data was two ten-minute windows of Arc mainnet (blocks 22349338–22350537 and
22351436–22352635), every receipt captured. The audit took four independent routes:

1. **Flows, not events.** Each transaction was relabelled from token movements alone:
   - who initiated it (the EOA, the ERC-4337 account, or the EIP-3009 payer);
   - that party's net token in/out;
   - position NFTs minted or burned;
   - USDC minted or burned.

   This labeller was then cross-tabulated against the event-based labels.
2. **By hand.** Every group where the two readings disagreed was read transaction by
   transaction, using decoded method names, event names and token symbols. Symbols came from
   `eth_call symbol()`; names came from the openchain signature database.
3. **Contract identity.**
   - **Uniswap v4:** the Arc PoolManager, PositionManager and Universal Router match the
     official deployment list (developers.uniswap.org).
   - **CCTP:** verified on chain. The standard MessageTransmitterV2 answers
     `localDomain() = 26` (Arc), and TokenMessengerV2 points at it.
   - **Relay Depository:** its address matches explorers on other chains.
   - **Pools emitting the Uniswap-v3 `Swap` event:** each pool was asked `factory()`. One
     factory runs the canonical UniswapV3Factory bytecode, identical once the self-address
     immutable is masked. Another is Aerodrome's Aero Lite CL factory (DefiLlama adapters).
     Three more factories are unidentified.
4. **Behaviour.** Sub-cent native sends were checked by asking whether their recipients went
   on to transact. They had.

## What was wrong

| Where | Finding | Size (per 10 min) |
|---|---|---|
| Feed | USDC is Arc's native currency. Value sends log only a `Transfer` from `0xff…fe`. The feed read only the ERC-20 interface at `0x3600…`. | The wall saw 24% of USDC movements. In the other window, 1,587 transactions (~939k USDC) were invisible. |
| Feed | ERC-4337 EntryPoint → bundler gas refunds are native transfers. | 115 sub-cent rows, all filed as spam. |
| Parties | EIP-7702-delegated EOAs (`0xef0100…` code) were called contracts. | 268 of 663 "contracts", 951 movements |
| Facts | Relay's `FundsMovement` was read as a bridge. The Relay router logs it on same-chain swaps too. | ~150 swaps shown as bridge |
| Facts | WETH-style `Deposit`/`Withdrawal` was read as a vault. It was always wrapped USDC inside a swap. | 97 |
| Facts | Unrecognised: `disperseEther` batch payouts, bonding-curve buys, Seaport sales, reward claims, Across and intent fills. | 1,027 batch-payout movements alone |
| Rule | "Sub-cent with nothing else" = spam. On Arc a sub-cent native send buys gas: all 40 recipients of the busiest sender spent it on exactly one transaction. | 190 |
| Protocol | The Uniswap-v3 `Swap` event was named Uniswap. 29% of the pools logging it are Aerodrome's and others'. | 126 events |

What held up:
- event-based swap labels (93% agree with flows, and the rest were MEV bots and "swap and
  send" transactions);
- Relay deposits and CCTP in both directions;
- liquidity, including keeper fee collection and Safe-module position adds;
- EIP-3009 signed payments. These are sub-cent and all go through one facilitator, with 36
  payers and 37 payees. That is a micropayment network, not dust.

## Decisions

1. **Read both ways USDC moves.**
   - `eth_getLogs` reads `[USDC, 0xff…fe]`.
   - Each ERC-20 log consumes its native twin (same parties, value × 10¹²).
   - A native value is rounded up to 6 decimals, so no non-zero movement reads as zero.
2. **Skip the bundler's gas refund.** A transfer from an EntryPoint to the transaction's
   sender is gas. A plain transaction pays gas with no log at all.
3. **An EIP-7702 account is a wallet.** Code that is exactly `0xef0100` plus 20 bytes is
   treated as a wallet.
4. **Correct the table.** Remove `FundsMovement`. Move WETH events to a `wrap` fact. Add
   `batch`, `payout`, `market`, bonding-curve swaps, Across/intent fills, smart-account entry
   points, and bridge direction.
5. **Name the exchange by the pool, not the event.**
   - The feed asks each swapping pool its `factory()` once, cached.
   - "Uniswap" is used for: the Uniswap Universal Router or PositionManager as `tx.to`, the
     v4 PoolManager as emitter, or a pool from the verified v3 factory.
   - "Aerodrome" is used for pools from the Aero Lite CL factory.
6. **The transfer decides three lanes** (`summarize.ruled_lane`):
   - **Mint/burn:** when one side is the zero address and nothing says bridge. As a model
     option, "issuance" drew probability from every lane: 93.5% agreement with it offered,
     99.9% without.
   - **Spam:** when the transfer moved exactly zero USDC and only the sender kind or a fee is
     beside it.
   - **Uncertain:** when nothing in the transaction is recognisable, or its context could not
     be read. Asked anyway, the model answered "vault" at 0.82 or "lending" at 0.64 depending
     only on the wording.
7. **The model decides the rest from 8 options**, described with the tie-break spelled out
   ("…even if tokens were also swapped"). The instruction is "What kind of Arc transaction is
   this?". Spam stays in the list as the last option: the model never picks it (p≈0.02), but
   removing it cost 1.3 points of agreement and 0.12 of confidence. Option order is part of
   the question; moving spam first cost 14 points.
8. **Two sentences.**
   - The lane reads `shape`, as before but with the corrected facts.
   - Viewers' questions read `story`. It adds:
     - a size in words ("a medium amount");
     - bridge direction ("(out of Arc)");
     - the verified protocol;
     - "a gasless signed payment";
     - "liquidity was added to or removed from a pool".

   These same additions in the lane sentence made the model call swaps spam (91.5%), so the
   sentences differ. Laya reads every question of a state as its own sequence, so splitting
   the call costs a round trip, not forward passes.
9. **Questions are prefixed** "About this Arc USDC transfer: ".
10. **Each question gets its own yes line.** It is the log-odds midpoint of the question's
    second-lowest and second-highest scores over the probe set, measured when the gate
    accepts it. The page highlights at that line instead of 0.5. On 4,000 live transfers,
    balanced accuracy was 0.773 at a flat 0.5, 0.783 at the probability midpoint and 0.823
    at this line. It fixes the questions whose answers crowd near zero ("was a fee taken?":
    0.60 → 0.99), and costs a little on a few whose answers spread wide.
11. **The gate's probe set is rewritten** in the story format as 35 transfers, with every
    fact in several of them. With a fee in one probe of 24, "was a fee taken?" separated
    them by 0.08 and was refused as flat.
12. **The gate lets through everything it cannot prove flat.** Its founding claim, that
    polished nonsense "collapses" on real transfers, did not hold on Arc: the model answers
    "does this payment like jazz music?" differently for payments and swaps. No separation
    statistic tried (raw, residual against a nonsense profile, top-3 against bottom-3) kept
    all real questions above all nonsense. So MIN_SEPARATION is 0.12. That refuses no real
    question (the weakest, the fee question, separates by 0.16) and half of 14 nonsense
    ones. The old 0.20 refused the fee question and let "is the ocean blue today?" through.
13. **The control question is asked only alongside viewer questions.** It had fired on 0 of
    ~16k Arc sentences.

## Measured

All numbers are against the audited truth. The first version is PR #18 as it ran live. The
new column is `scripts/eval.py` on the implementation.

| | Live (PR #18), window 2 | New, window 2 | New, capture of 1,200 | New, capture of 4,000 |
|---|---|---|---|---|
| USDC movements on the wall | 24% | 100% (gas refunds excepted) | 100% | 100% |
| Lanes agree with the evidence | 78.9%, 15.8% uncertain | 99.9%, 0.1% uncertain | 99.8% | 99.9% |
| Right-lane confidence (mean) | — | 0.83 | 0.83 | 0.83 |
| 24 viewer questions, mean AUC | 0.759 | 0.931 | 0.926 | 0.918 |
| 24 viewer questions, balanced accuracy | 0.641 (at 0.5) | 0.834 | 0.832 | 0.823 |
| Real questions the gate refuses | — | 0 | 0 | 0 |

## What is still weak

- Numbers the model must compare, like "is this less than one dollar?". Words help: that
  question's AUC went from 0.35 to about 0.7, but that is still weak.
- The gate cannot tell half of polished nonsense from a real question (decision 12).
- A few questions lose a little to the log-odds line: bridge 0.81 → 0.75, smart account
  0.94 → 0.84.
- A transaction with one protocol named hides a second one. A Relay deposit that swapped on
  Uniswap reads "Protocol: Relay".
- NFT mints through smart accounts read as payments. No lane fits them, and an "NFT minted"
  fact lowered confidence without changing the lane.
- Three v3-fork factories and the OKX, Kyber, 1inch and 0x rules are not verified on Arc.
