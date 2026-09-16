/**
 * The hero backdrop.
 *
 * Two agents, one agreement, drawn as an instrument rather than an illustration: two nodes, a
 * link between them, and a lattice of commitments around it. There is deliberately no robot, no
 * face and no neural mesh here — the status bar says the buyer and provider agents are deterministic
 * programs rather than language models, and the artwork must not quietly imply otherwise.
 *
 * The geometry is DERIVED, not drawn: every node position, size and connection comes from the
 * build's own contract-source hash, so the pattern is deterministic, unique to this build, and
 * changes only when the contracts do. That is the same idea the whole product rests on — a
 * commitment to exact bytes — expressed as light.
 *
 * It is masked out of the centre column so nothing is ever rendered behind readable text, is
 * `aria-hidden`, takes no pointer events, and stops moving under `prefers-reduced-motion`.
 */

interface Node {
  x: number;
  y: number;
  r: number;
  o: number;
}

/** xorshift32, seeded from a hex digest. Same hash in, same field out. */
function seeded(hash: string) {
  let s = 0x9e3779b9;
  for (const ch of hash.replace(/^0x/, "")) s = (Math.imul(s ^ ch.charCodeAt(0), 0x85ebca6b) >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

export function AgentField({ seed }: { seed?: string }) {
  const rnd = seeded(seed || "acceptance-mvp");
  const W = 1600;
  const H = 760;

  // The two principals, set wide and level with the headline so the title sits between them,
  // and far enough out to clear the centre mask rather than being erased by it.
  const a = { x: 176, y: 336, r: 5.5 };
  const b = { x: W - 176, y: 300, r: 5.5 };

  // A lattice of commitments, pushed out of the centre where the text lives.
  //
  // Sampled per side to an equal count. Left to pure chance the seed clusters everything on one
  // flank, which reads as an accident rather than a composition.
  const nodes: Node[] = [];
  const PER_SIDE = 15;
  for (const [lo, hi] of [[60, W / 2 - 40], [W / 2 + 40, W - 60]] as [number, number][]) {
    let placed = 0;
    for (let guard = 0; placed < PER_SIDE && guard < 900; guard++) {
      const x = lo + rnd() * (hi - lo);
      const y = 54 + rnd() * (H - 108);
      const fromCentre = Math.hypot((x - W / 2) / (W / 2), (y - H / 2) / (H / 2));
      if (fromCentre < 0.58) continue;
      nodes.push({ x, y, r: 1.1 + rnd() * 2.4, o: 0.35 + rnd() * 0.65 });
      placed++;
    }
  }

  // Short links between near neighbours. Sparse: a constellation, not a mesh.
  const links: [Node, Node][] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const d = Math.hypot(nodes[i]!.x - nodes[j]!.x, nodes[i]!.y - nodes[j]!.y);
      if (d < 170 && rnd() > 0.55) links.push([nodes[i]!, nodes[j]!]);
    }
  }

  // The agreement: one arc from buyer to provider, meeting at the point of verification.
  // Routed over the top, through the band the mask leaves visible. An arc whose centre is masked
  // away says nothing, which is what the first attempt did.
  const arc = `M ${a.x} ${a.y} C ${W * 0.28} ${H * 0.04}, ${W * 0.72} ${H * 0.04}, ${b.x} ${b.y}`;

  return (
    <svg className="agentfield" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="af-node">
          <stop offset="0%" stopColor="var(--beam)" stopOpacity="0.95" />
          <stop offset="100%" stopColor="var(--beam)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="af-arc" x1="0" x2="1">
          <stop offset="0%" stopColor="var(--beam)" stopOpacity="0" />
          <stop offset="28%" stopColor="var(--beam)" stopOpacity="0.55" />
          <stop offset="50%" stopColor="var(--go)" stopOpacity="0.7" />
          <stop offset="72%" stopColor="var(--beam)" stopOpacity="0.55" />
          <stop offset="100%" stopColor="var(--beam)" stopOpacity="0" />
        </linearGradient>
      </defs>

      <g className="af-lattice">
        {links.map(([p, q], i) => (
          <line key={i} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="var(--beam)" strokeWidth="0.7" opacity={0.2} />
        ))}
        {nodes.map((n, i) => (
          <circle key={i} cx={n.x} cy={n.y} r={n.r} fill="var(--beam)" opacity={n.o * 0.8} />
        ))}
      </g>

      {/* The agreement between the two principals. */}
      <path className="af-arc" d={arc} fill="none" stroke="url(#af-arc)" strokeWidth="1.4" />

      {[a, b].map((p, i) => (
        <g key={i} className="af-agent" style={{ animationDelay: `${i * 1.6}s` }}>
          <circle cx={p.x} cy={p.y} r={p.r * 13} fill="url(#af-node)" opacity="0.62" />
          <circle cx={p.x} cy={p.y} r={p.r} fill="var(--beam)" opacity="0.85" />
          <circle cx={p.x} cy={p.y} r={p.r * 3.6} fill="none" stroke="var(--beam)" strokeWidth="0.8" opacity="0.42" />
        </g>
      ))}
    </svg>
  );
}
