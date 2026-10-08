import Link from 'next/link';
import { Fragment } from 'react';
import { shortAddr } from '../lib/format.js';
import { nameOf } from '../lib/names.js';
import type { FlowView } from '../lib/txstory.js';

export function Flow({ flow }: { flow: FlowView }) {
  return (
    <div className="flow">
      {flow.nodes.map((node, i) => {
        const name = nameOf(node.address);
        const edge = flow.edges[i];
        return (
          <Fragment key={i}>
            <Link href={`/address/${node.address}`} className="node" title={node.address} prefetch={false}>
              <span className="k">{node.role}</span>
              <span className={name ? 'v named' : 'v'}>{name ?? shortAddr(node.address)}</span>
            </Link>
            {edge && (
              <div className="edge">
                <span className="amt">
                  {edge.amount}
                  <small>USDC</small>
                </span>
                <span className="line" />
                <span className="log">log #{edge.li}</span>
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
