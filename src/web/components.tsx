import type { ReactNode } from "react";
import { formatCents, short } from "./api.ts";

export type Tone = "go" | "no" | "hold" | "idle";

export function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`chip ${tone}`}>
      <span className="led" aria-hidden="true" />
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  PAID: "go", REJECTED: "no", EXPIRED: "hold", BLOCKED_AT_CREATION: "hold",
  CANCELLED: "idle", SUBMITTED: "idle", FUNDED: "idle", ACCEPTED: "idle", CREATED: "idle",
};

export function StatusChip({ status }: { status: string }) {
  return <Chip tone={STATUS_TONE[status] ?? "idle"}>{status.replace(/_/g, " ").toLowerCase()}</Chip>;
}

/** Human label first; the address is one disclosure away for anyone who wants it. */
export function Party({ role, address }: { role: string; address?: string }) {
  return (
    <span>
      {role}
      {address && (
        <details className="fold" style={{ display: "inline-block", border: "none", background: "none", marginLeft: 10, verticalAlign: "middle" }}>
          <summary style={{ padding: "1px 7px", fontSize: "0.6875rem" }}>
            <span className="caret" aria-hidden="true" />address
          </summary>
          <span className="mono" style={{ display: "block", padding: "7px 0 0" }}>{address}</span>
        </details>
      )}
    </span>
  );
}

export function Rows({ rows, hit }: { rows: { productId: string; priceCents: string }[]; hit?: string[] }) {
  if (!rows.length) return <p className="note">No rows.</p>;
  return (
    <table>
      <caption>{rows.length} rows. Prices are integer cents; nothing here is a floating-point number.</caption>
      <thead>
        <tr><th style={{ width: 30 }}>#</th><th>Product ID</th><th className="num">Price</th></tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={hit?.includes(r.productId) ? "hit" : undefined}>
            <td className="dim mono">{i}</td>
            <td className="mono">{r.productId}</td>
            <td className="num">{formatCents(r.priceCents)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Fold({ label, children, open = false }: { label: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="fold" open={open}>
      <summary><span className="caret" aria-hidden="true" />{label}</summary>
      <div className="inner">{children}</div>
    </details>
  );
}

export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {items.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TxList({ transactions }: { transactions: any[] }) {
  if (!transactions?.length) return <p className="note">No transactions yet.</p>;
  return (
    <table>
      <thead><tr><th>Step</th><th>Transaction</th><th className="num">Block</th><th className="num">Gas</th></tr></thead>
      <tbody>
        {transactions.map((t, i) => (
          <tr key={i}>
            <td>{t.step}</td>
            <td className="mono dim" title={t.hash}>{short(t.hash)}</td>
            <td className="num">{t.blockNumber}</td>
            <td className="num">{Number(t.gasUsed).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Fault({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  if (!message) return null;
  return (
    <div className="fault lift" role="alert">
      <div className="between">
        <span>{message}</span>
        <button className="bare sm" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}

export function RunLog({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return (
    <ul className="runlog">
      {lines.map((l, i) => (
        <li key={i} className="lift" style={{ animationDelay: `${i * 50}ms` }}>
          <span className="tick" aria-hidden="true">◆</span>
          <span>{l}</span>
        </li>
      ))}
    </ul>
  );
}

export function Segment<T extends string>({
  value, options, onChange, label,
}: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segment" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} role="tab" aria-selected={value === o.id} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Readout({ k, v, unit, tone }: { k: string; v: string; unit?: string; tone?: "up" | "down" }) {
  return (
    <div className="readout-cell">
      <div className="k">{k}</div>
      <div className={`v ${tone ?? ""}`}>
        {v}{unit && <span className="u"> {unit}</span>}
      </div>
    </div>
  );
}
