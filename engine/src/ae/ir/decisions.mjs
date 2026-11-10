// Choices that trade EDITABILITY for FIDELITY are never made quietly.
//
// The importer always takes the editable path and records the alternative as a
// decision. The command line then puts it in front of a person -- interactively
// when there is a terminal, as a printed list and a flag otherwise -- and the
// build is repeated with whatever was accepted. Nothing silently becomes a
// bitmap because it was easier.
//
// A decision is only warranted where the two paths genuinely differ. Baking a
// group's opacity when its children cannot overlap, or tiling a background with
// Motion Tile, are exact AND editable: those are not decisions, they are just
// the right answer.

/** The kinds a person can accept, with what each costs and gains. */
export const KINDS = {
  gradients: {
    summary: 'gradients with more than two stops',
    keeps: 'an editable two-stop Gradient Ramp, missing the middle stops',
    gains: 'an exact bitmap of the gradient, no longer an editable ramp',
  },
  transforms: {
    summary: 'transforms After Effects cannot express',
    keeps: 'the closest transform AE can hold, which is visibly wrong',
    gains: 'an exact rasterised sequence, no longer an editable transform',
  },
  backdrop: {
    summary: 'backdrop-filter',
    keeps: 'the element without its backdrop effect',
    gains: 'an exact rasterised sequence of the element and its backdrop',
  },
  fonts: {
    summary: 'text in fonts that are not installed',
    keeps: 'a substituted face at the wrong width',
    gains: 'an exact rasterised sequence of the text',
  },
};

export class Decisions {
  constructor(accepted = new Set()) {
    this.accepted = accepted instanceof Set ? accepted : new Set(accepted);
    this.items = [];
  }

  /**
   * Record a decision and report whether the fallback was accepted.
   * Callers use the return value to choose which path to build.
   */
  offer({ kind, layerId, layerName, detail, render = null }) {
    const meta = KINDS[kind] || { summary: kind, keeps: 'the default', gains: 'the fallback' };
    const accepted = this.accepted.has(kind) || this.accepted.has('all');
    this.items.push({
      kind,
      layerId,
      layerName,
      detail,
      render,
      accepted,
      keeps: meta.keeps,
      gains: meta.gains,
    });
    return accepted;
  }

  /** One entry per KIND, for prompting -- nobody wants forty y/n questions. */
  grouped() {
    const byKind = new Map();
    for (const item of this.items) {
      if (!byKind.has(item.kind)) {
        byKind.set(item.kind, {
          kind: item.kind,
          summary: (KINDS[item.kind] || {}).summary || item.kind,
          keeps: item.keeps,
          gains: item.gains,
          accepted: item.accepted,
          layers: [],
          // What the fallback would need in order to be built, if taken.
          render: [],
        });
      }
      const g = byKind.get(item.kind);
      g.layers.push(item.layerName || String(item.layerId));
      if (item.render) g.render.push(item.render);
    }
    return [...byKind.values()];
  }

  get pending() {
    return this.grouped().filter((g) => !g.accepted);
  }
}
