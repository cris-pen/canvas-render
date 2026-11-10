// Collapsing a staggered run of spans into ONE text layer with a text animator.
//
// A designer writing "Motion that carries" as three <span>s with 120/260/400ms
// delays does not want three layers in After Effects -- they want one text
// layer they can retype, with a stagger they can re-time from one place. Three
// layers is what a literal import gives, and it is the thing that makes an
// imported title unusable for real work.
//
// The detection is deliberately NUMERIC rather than a reading of the CSS. Every
// member's motion is tested for being a scalar blend between two states:
//
//     value(t) = to + u(t) * (from - to)
//
// If one u(t) explains every animated property of a span, that span's whole
// animation is exactly a Range Selector Amount of u(t)*100 over an animator
// holding `from`. Nothing here needs to know what produced the motion, so a
// stagger driven by JS collapses on the same terms as one written in
// @keyframes -- and anything that is NOT a clean two-state blend fails the test
// and keeps its own layer, which is the honest fallback.
import { buildScalarTrack } from './track.mjs';

// How far a member may stray from the fitted blend before the run is judged
// unclean, in the units of each property (px, percent, degrees).
const BLEND_TOLERANCE = 0.75;
// Two members whose animations start within this are simultaneous, not
// staggered, and collapsing them buys nothing.
const MIN_STAGGER = 0.016;

// The animated state is compared as one flat vector, so the indices are named
// once here rather than counted at each use.
const S = { X: 0, Y: 1, Z: 2, SX: 3, SY: 4, ROT: 5, RX: 6, RY: 7, RZ: 8, OPACITY: 9 };

/** The animated part of a span's transform at one frame, as a flat vector. */
function stateAt(p) {
  if (!p || !p.transform) return null;
  const t = p.transform;
  const o = t.orientation || [0, 0, 0];
  return [
    t.absolutePosition[0], t.absolutePosition[1], t.absolutePosition[2],
    t.scale[0], t.scale[1],
    // A 2D layer's spin lives in `rotation`; only a 3D one uses `orientation`.
    // Reading just the latter made a plain rotate-in stagger look like pure
    // translation, so it collapsed with the rotation silently deleted.
    t.rotation || 0,
    o[0], o[1], o[2],
    t.opacity,
  ];
}

const sub = (a, b) => a.map((v, i) => v - b[i]);
// Serialised transforms carry a little float noise; a hundredth of a pixel or
// a hundredth of a percent is not a movement worth writing an animator for.
const moved = (v) => v.some((x) => Math.abs(x) > 0.01);
const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

/**
 * Fit one member's frames to a two-state blend, returning the blend amount per
 * frame plus the `from` offset, or null when no single u(t) explains them.
 */
function fitBlend(perFrame) {
  const states = perFrame.map(stateAt);
  const present = states.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
  if (present.length < 3) return null;

  // The settled state is the last frame the span is present: CSS `both` fill
  // leaves it parked on the animation's end state.
  const to = states[present[present.length - 1]];
  // `from` is the frame that strays furthest from settled -- for an entrance
  // that is the first frame, but this does not assume it.
  let far = present[0];
  let farDist = 0;
  for (const i of present) {
    const d = norm(sub(states[i], to));
    if (d > farDist) { farDist = d; far = i; }
  }
  if (farDist < 0.5) return null;             // never actually moves
  const delta = sub(states[far], to);
  const dd = delta.reduce((s, x) => s + x * x, 0);

  // Project every frame onto that one direction, then check the projection
  // actually reproduces the frame. A span that moves in a direction the `from`
  // state cannot explain fails here, which is the whole point of the test.
  const amount = [];
  let worstResidual = 0;
  for (let i = 0; i < states.length; i += 1) {
    const s = states[i];
    if (!s) { amount.push({ t: perFrame[i].time, v: null }); continue; }
    const d = sub(s, to);
    const u = d.reduce((acc, x, k) => acc + x * delta[k], 0) / dd;
    const residual = norm(sub(d, delta.map((x) => x * u)));
    if (residual > BLEND_TOLERANCE) return null;
    worstResidual = Math.max(worstResidual, residual);
    amount.push({ t: perFrame[i].time, v: u * 100 });
  }
  // When the blend first leaves its start value -- the span's delay, and what
  // makes this a stagger rather than three copies of one animation.
  const first = amount.find((a) => a.v !== null);
  let start = amount[amount.length - 1].t;
  for (const a of amount) {
    if (a.v !== null && Math.abs(a.v - first.v) > 0.5) { start = a.t; break; }
  }
  return { amount, delta, start, worstResidual, to };
}

/**
 * Find runs of sibling text spans that share one animation on a delay.
 *
 * `members` come back in document order with the character range each occupies
 * in the joined string, which is what the Range Selectors are written from.
 */
export function detectStaggers(analyses, opts = {}) {
  const byId = new Map(analyses.map((a) => [a.node.id, a]));
  const childrenOf = new Map();
  for (const a of analyses) {
    const key = a.node.parentId;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(a);
  }

  const runs = [];
  for (const [parentId, kids] of childrenOf) {
    if (parentId === null || kids.length < 2) continue;
    const parent = byId.get(parentId);
    if (!parent) continue;
    // Every child must be a text span with text of its own, or this is a
    // layout row that merely happens to hold text.
    if (!kids.every((k) => k.node.role === 'text')) continue;
    const textOf = (k) => {
      const f = k.perFrame.find((p) => p.entry && p.entry.present && p.entry.text);
      return f ? f.entry.text.trim() : '';
    };
    if (!kids.every((k) => textOf(k).length)) continue;

    const blends = kids.map((k) => fitBlend(k.perFrame));
    if (blends.some((b) => !b)) continue;

    // One animator carries one `from` state, so every member's offset from
    // settled has to be the same -- same distance, same direction.
    const ref = blends[0].delta;
    const settled = blends[0].to;

    // WHICH END DOES THE LAYER HOLD, and which end does the animator hold?
    //
    // For an entrance the layer is parked on the settled state and the animator
    // holds the state it came FROM, weighted by an Amount that falls to zero.
    // An exit cannot be built that way: its settled state is invisible, and
    // After Effects MULTIPLIES a layer's Opacity through the text, so a layer
    // parked at 0 renders nothing no matter what the animator says -- the whole
    // run disappears. So an exit is built the other way round: the layer holds
    // the state it starts in, the animator holds the settled state, and the
    // Amount rises to select it.
    const exit = ref[S.OPACITY] > 0.5;
    const end = exit ? settled : settled.map((v, i) => v + ref[i]);
    const parked = exit ? settled.map((v, i) => v + ref[i]) : settled;
    const sameMotion = blends.every((b) => norm(sub(b.delta, ref)) <= BLEND_TOLERANCE);
    if (!sameMotion) continue;

    // Strictly increasing starts: that is what makes it a stagger. Equal
    // starts are one animation on several spans and collapse to nothing.
    const starts = blends.map((b) => b.start);
    let staggered = true;
    for (let i = 1; i < starts.length; i += 1) {
      if (starts[i] - starts[i - 1] < MIN_STAGGER) staggered = false;
    }
    if (!staggered) continue;

    // One text layer lays out one run of text, so every member has to sit on
    // the same line. A wrapped run keeps its own layers rather than being
    // re-flowed by After Effects into a shape the design never had.
    const firstEntry = (k) => k.perFrame.find((p) => p.entry && p.entry.present);
    const tops = kids.map((k) => { const e = firstEntry(k); return e ? e.entry.box[1] : null; });
    if (tops.some((v) => v === null)) continue;
    if (Math.max(...tops) - Math.min(...tops) > 2) continue;

    // The joined string, with the whitespace the browser ACTUALLY laid out
    // between the spans -- decided by measuring the gap, not by assuming one.
    // Inline elements separated by a newline in the source render one space and
    // dropping it would re-flow the line; but a per-character run written flush
    // (<span>M</span><span>o</span>) has no space, and inserting one turns
    // "Motion" into "M o t i o n".
    const boxOf = (k) => { const e = firstEntry(k); return e ? e.entry.box : null; };
    let text = '';
    const members = kids.map((k, i) => {
      if (i > 0) {
        const prev = boxOf(kids[i - 1]);
        const here = boxOf(k);
        const gap = prev && here ? here[0] - (prev[0] + prev[2]) : 0;
        if (gap > 0.5) text += opts.separator ?? ' ';
      }
      const charStart = text.length;
      text += textOf(k);
      return {
        id: k.node.id,
        name: k.node.name,
        text: textOf(k),
        charStart,
        charEnd: text.length,
        start: blends[i].start,
        // Kept so the importer can restyle just this word's characters: a run
        // is only worth collapsing if the ONE layer can still carry the design,
        // and in practice one word in a title is nearly always set apart.
        style: (() => {
          const e = firstEntry(k);
          if (!e) return null;
          const st = e.entry.style;
          return {
            color: st.color,
            italic: st.fontStyle === 'italic',
            weight: st.fontWeight,
            family: st.fontFamily,
            size: st.fontSize,
          };
        })(),
        // u falls 1 -> 0 as a span settles. An exit selects the OTHER end, so
        // its Amount is the complement and rises 0 -> 100 instead.
        amount: buildScalarTrack(
          exit ? blends[i].amount.map((a) => ({ t: a.t, v: a.v === null ? null : 100 - a.v }))
            : blends[i].amount,
          'opacity', { tolerance: 0.2 },
        ),
      };
    });

    runs.push({
      parentId,
      members,
      text,
      // The animator's `from` state. Position is an OFFSET in After Effects,
      // so the measured delta goes in as it stands; scale and opacity are
      // ABSOLUTE values the selected characters take, so they are the settled
      // value plus the delta. Anything that did not really move is left off
      // entirely rather than written as a no-op property.
      exit,
      from: {
        // Position is an OFFSET in After Effects: from the parked state to the
        // one the animator holds. The other three are absolute values the
        // selected characters take.
        position: moved([ref[S.X], ref[S.Y], ref[S.Z]])
          ? [end[S.X] - parked[S.X], end[S.Y] - parked[S.Y], end[S.Z] - parked[S.Z]] : null,
        scale: moved([ref[S.SX], ref[S.SY]]) ? [end[S.SX], end[S.SY]] : null,
        rotation: Math.abs(ref[S.ROT]) > 0.05 ? end[S.ROT] : null,
        opacity: Math.abs(ref[S.OPACITY]) > 0.5 ? end[S.OPACITY] : null,
      },
      stagger: starts[1] - starts[0],
      // How far the measured motion strayed from the two-state blend the
      // animator reproduces. This is the run's real fidelity number: the layer
      // itself is static now, so a position check on it would say nothing.
      residual: Math.max(...blends.map((b) => b.worstResidual)),
    });
  }
  return runs;
}
