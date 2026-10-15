/**
 * <rfp-radar-matches> web component: drops the Radar match list into any page, including RFP Pilot.
 *
 * Security model: the component never holds a Radar API key. It calls `endpoint`, which must be a route on
 * the host application (for RFP Pilot, a server-side proxy that adds the tenant's key). Clicking
 * "Send to RFP Pilot" dispatches a `radar-handoff` DOM event with the opportunity id; the host decides what
 * to do (typically: call its proxy for /handoff and open a solicitation workspace).
 *
 *   <rfp-radar-matches endpoint="/api/radar/profiles/isf-main/matches"></rfp-radar-matches>
 */
interface Item {
  match: { score: number; band: string; reasons: { points: number; detail: string }[] };
  opportunity: {
    id: string;
    title: string;
    buyer: { name: string };
    dueAt: string | null;
    kindLabel: string | null;
    kind: string;
    provenance: { sourceUrl: string };
  };
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmt = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "No due date";

const STYLE = `
:host{display:block;font-family:Inter,system-ui,sans-serif;color:var(--radar-ink,#14213D)}
.row{border:1px solid var(--radar-line,#D3E1EC);border-radius:8px;padding:12px 14px;margin:0 0 10px;background:var(--radar-bg,#fff)}
.t{font-weight:600;font-size:15px;margin:0 0 4px}
.t a{color:inherit;text-decoration:none}.t a:hover{text-decoration:underline}
.m{font-size:12.5px;color:var(--radar-muted,#556175);margin:0 0 6px}
.why{font-size:12.5px;margin:0 0 8px}
.score{float:right;font-weight:700;font-size:13px;color:#fff;background:linear-gradient(135deg,#1FB1D2,#2F6BE6);border-radius:12px;padding:2px 9px}
button{font:inherit;font-size:12.5px;font-weight:600;border:0;border-radius:6px;padding:6px 10px;background:var(--radar-accent,#1A75C8);color:#fff;cursor:pointer}
.empty,.err{font-size:13px;color:var(--radar-muted,#556175)}`;

export class RadarMatchesElement extends HTMLElement {
  static observedAttributes = ["endpoint"];
  private root = this.attachShadow({ mode: "open" });

  connectedCallback() {
    void this.load();
  }
  attributeChangedCallback() {
    if (this.isConnected) void this.load();
  }

  private async load() {
    const endpoint = this.getAttribute("endpoint");
    if (!endpoint) return;
    this.root.innerHTML = `<style>${STYLE}</style><p class="empty">Loading opportunities…</p>`;
    try {
      const res = await fetch(endpoint, { credentials: "same-origin" });
      if (!res.ok) throw new Error(String(res.status));
      const { matches } = (await res.json()) as { matches: Item[] };
      this.render(matches);
    } catch {
      this.root.innerHTML = `<style>${STYLE}</style><p class="err">Radar is unavailable right now.</p>`;
    }
  }

  private render(items: Item[]) {
    if (items.length === 0) {
      this.root.innerHTML = `<style>${STYLE}</style><p class="empty">No matching opportunities right now.</p>`;
      return;
    }
    const rows = items
      .map(({ match: m, opportunity: o }) => {
        const why = m.reasons
          .filter((r) => r.points > 0)
          .map((r) => esc(r.detail))
          .join("; ");
        return `<div class="row"><span class="score">${Math.round(m.score)}</span>
<p class="t"><a href="${esc(o.provenance.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(o.title)}</a></p>
<p class="m">${esc(o.buyer.name)} · ${esc(o.kindLabel ?? o.kind)} · due ${fmt(o.dueAt)}</p>
${why ? `<p class="why">${why}</p>` : ""}
<button data-id="${esc(o.id)}">Send to RFP Pilot</button></div>`;
      })
      .join("");
    this.root.innerHTML = `<style>${STYLE}</style>${rows}`;
    this.root.querySelectorAll("button[data-id]").forEach((b) =>
      b.addEventListener("click", () =>
        this.dispatchEvent(
          new CustomEvent("radar-handoff", {
            detail: { opportunityId: (b as HTMLElement).dataset.id },
            bubbles: true,
            composed: true,
          }),
        ),
      ),
    );
  }
}

if (typeof customElements !== "undefined" && !customElements.get("rfp-radar-matches")) {
  customElements.define("rfp-radar-matches", RadarMatchesElement);
}
