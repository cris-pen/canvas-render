# The coordinate model

Every layer's space has its origin at the element's **untransformed border-box
top-left**. Once that is fixed, CSS and After Effects line up term for term.

CSS maps a local point `p` into its parent's space as

```
p_parent = layoutOffset + O + M_linear . (p - O) + M_translate
```

where `O` is `transform-origin` and `M` is the element's own transform matrix.

After Effects maps a layer point `p` into its parent layer's space as

```
p_parent = Position + R(rotation) . S(scale) . (p - AnchorPoint)
```

Setting

```
AnchorPoint = O
Position    = layoutOffset + O + M_translate
R . S       = M_linear
```

makes them identical. Note what is *not* needed: no correction for the parent's
anchor point, because AE subtracts the parent's anchor from points in the
parent's space rather than shifting the space itself. That claim is checked
against the running application by `D2AE.verifyCoordinateModel` before any
import, rather than trusted.

## Skew

AE's layer transform has no skew term, but CSS produces one routinely.
`decompose2d` yields `M_linear = R . SkewX(shear) . S`, whereas AE offers only
`R . S`. The identity

```
R . SkewX(shear) . S  ==  R . S . SkewX(shear * sy / sx)
```

lets the skew move into a Transform *effect*, which acts on the layer's source
before the layer transform. The composition is exact.

## Recovering a box behind a running transition

The flat pass switches transforms off to read exact layout boxes. One case
escapes it: the CSS cascade places transition declarations **above** `!important`
author rules, so a mid-flight transform transition survives.

Worse, Chromium destroys and recreates a transform `CSSTransition` when the flat
sheet touches it: the animation object's clock resets to zero on every frame and
the motion never advances. The probe therefore hoists transform transitions into
equivalent script-created `Animation`s: keyframes, timing and easing copied
verbatim, so the motion is still the transition's own, but script animations sit
*below* `!important` in the cascade and nothing recreates them.

The swap must be atomic (cancel and replace in one synchronous block with no
forced style flush between), or the browser generates a fresh transition from the
intermediate state. Setting `transition-property: none` around the swap is *not*
a valid alternative: it cancels every transition on the element, so hoisting a
transform transition would snap a concurrent colour transition to its end value.

Where a residual transform does survive, the probe undoes it analytically. The
origin terms cancel, leaving a closed form that needs no matrix inverse:

```
box = flatTopLeft - localAabbTopLeft - O + A.O - t
```

## What After Effects actually does

Measured against After Effects 26.3.0.87 on 2026-08-20, not inferred. Each of
these was a real defect found by running the importer and reading values back
out of the application.

### Parenting rewrites the child's Position

Assigning `child.parent = parent` makes AE **recalculate the child's transform**
so the layer does not move on screen:

| | child Position after attach | `sourcePointToComp([0,0])` |
| --- | --- | --- |
| `child.parent = p` | rewritten `[10,20]` → `[-15,45]` | `[10,20]` ✗ |
| `child.setParentWithJump(p)` | stays `[10,20]` | `[60,70]` ✓ |
| parent first, *then* set values | stays `[10,20]` | `[60,70]` ✓ |

Our positions are already expressed in the parent's space, so that compensation
is exactly wrong: it cancels the parent's transform out of every nested layer.
The builder therefore parents in a separate pass **before** writing any
transform value, and uses `setParentWithJump` where it exists.

### New layers are added at the top

`comp.layers.addShape()` inserts at index 1. CSS paints later elements over
earlier ones, so layers must be created in **forward** document order. Creating
them backwards puts the page background on top and renders the whole comp as a
single flat rectangle, which is exactly what the first run produced.

### Ease arity is per-property, and not the dimension count

`setTemporalEaseAtKey` wants an array whose length matches the property, and
Scale is stored as **three**-dimensional even on a 2D layer: passing two eases
fails with *"Value array does not have 3 elements"*. Spatial properties want
exactly one. `D2AE.easeArity` reads `propertyValueType` and keeps a fallback
list rather than encoding a table that rots between versions.

### Text anchors at the first baseline

Every other layer here is anchored at its box top-left, but a text layer's
origin is the first baseline of the first line. Without a correction all
imported text floats up by roughly one ascent. The probe measures the real
offset with canvas font metrics and the half-leading model, and the anchor
becomes `transformOrigin - baselineOffset`.

### Font family and weight are separate

Setting `fontFamily` alone silently gives the Regular face, so a bold heading
imports light. `fontStyle` must be set too ("Bold", "Italic", "Bold Italic"),
with the PostScript name as a fallback.

### 3D under CSS perspective: two conventions differ

This one took the longest and is worth stating precisely, because both halves
are invisible until something lands in the wrong place.

**1. After Effects composes Orientation as `Rx . Ry . Rz`.**
Measured, not assumed: set Orientation to `[25, -40, 15]` on a 3D null and read
the images of the three basis vectors back. `toWorld()` is unavailable to
scripts (it is an EXPRESSION function), so the way to read it is to put it in
an expression and evaluate the property:

```js
var n = comp.layers.addNull();
n.threeDLayer = true;
n.transform.position.expression = 'thisComp.layer("subject").toWorld([1,0,0])';
var col0 = n.transform.position.valueAtTime(0, false);
```

The measured matrix matches `Rx . Ry . Rz` to 4e-7 and no other order comes
within 0.01. The per-axis matrices themselves are identical to the CSS ones;
`rotateX(30°)` builds the same matrix in both systems, so there is nothing to
convert there.

**2. The z axes point opposite ways.** CSS z points TOWARD the viewer; AE z
points away from it. The transform has to be conjugated by `diag(1, 1, -1, 1)`,
which negates the z translation and reverses rotation about x and y while
leaving rotation about z untouched. The projections then agree: CSS divides by
`(d - z)` and AE by `(z + d)`, which are the same thing once z has flipped.

With both applied, the model reproduces the browser to **0.18px** across the
whole animation. Ground truth for that check is measured rather than derived:
a 1px marker is placed at the element's own local origin and its on-screen rect
read back, and it runs in `test/threed.test.mjs` without needing After Effects,
so the 3D path is testable in CI.

### 3D rotation goes to X/Y/Z Rotation, not Orientation

Both properties build the *same* matrix (measured, identical to six decimals
for the triple `[25, -40, 15]`). They differ in how they INTERPOLATE:

- **Orientation** interpolates with quaternion **slerp**. Write a keyframe track
  to it and the layer lands exactly on every keyframe and drifts between them.
  The test panel was 30px off at t=1 while being pixel-exact at t=0 and at each
  key, which is the signature of an interpolation mismatch, not a transform
  error, and is worth recognising because it looks like a maths bug.
- **X Rotation / Y Rotation / Z Rotation** interpolate **per component**
  (confirmed: linear keys 0→90 give exactly 45 at the midpoint). That is what
  CSS does, and what the per-axis eases in these tracks describe.

So the importer writes the separate properties and leaves Orientation at zero.

### sourcePointToComp is the wrong readback for a 3D layer

Two traps, both of which produce confident nonsense:

1. It takes a **two-element** source-raster point. Three elements throws.
2. For a **3D** layer it does not return the camera-projected screen position.
   It agrees while the layer sits on z=0 (so it looks right at the start of an
   animation) and diverges as soon as the layer rotates out of the plane.

The honest readback is AE's own `toWorld()`, which is expression-only, followed
by the camera projection. With that, After Effects' world point for the test
panel is `[696.278, 61.233, 102.655]` against this repo's `[696.368, 61.055,
102.592]`, agreeing to 0.18px, and projecting AE's own world point gives
`[710.34, 72.46]`, the browser's answer.

The lesson worth keeping: when a verification disagrees, suspect the instrument
before the thing being measured. The importer was correct for several rounds
while the readback was not.

## What a real Claude Design project exposed

The synthetic fixture passed everything. A project authored through the actual
`/design` tooling immediately found four more, which is the argument for testing
on real output rather than on input shaped by the parser's author.

### perspective() as a transform function

Real design output writes `transform: perspective(900px) rotateY(22deg)
translateZ(-60px)`: perspective inside the transform list, on the element
itself, not `perspective:` on an ancestor. Three things follow:

1. The projection term lives in the element's OWN matrix, so the camera has to
   be derived from the element rather than from a container.
2. The browser serialises that matrix **un-normalised**: `m44` comes back as
   1.0618 for the tilt above.
3. Neither obvious handling of that is right. Normalising by `m44` *is* the
   perspective divide; it bakes the projection into the layer, so scale
   decomposes to 0.9418 instead of 1 and the translation arrives pre-projected.
   Leaving it alone mixes an un-normalised translation with a rotation that
   `decompose3d` normalised internally.

   The projection has to be **removed algebraically** and handed to the camera:
   `M = P · M'`, so `M' = P⁻¹ · M`. What remains is an ordinary 3D transform with
   `m44 = 1`, unit scale, and a true 3D translation. After that the element's
   origin lands on the browser's answer to **0.0000px**.

### A 3D element flattens its descendants

CSS without `preserve-3d` composites a 3D element's children into its plane and
projects the whole plane. After Effects will not do that for a 2D child of a 3D
parent: it composites the child against the parent's already-projected
position, which put a tilted lower-third's contents 3.5px out. Putting the whole
subtree into 3D space at z = 0 (which is exactly what "flattened into the
parent's plane" means) lets the camera project the group as one. That took the
error to 0.100px.

### Gradients are not always linear

The parser handled `linear-gradient` and returned null for anything else, so a
`radial-gradient` glow imported as nothing at all. Radial and conic share the
stop syntax; only the geometry differs, and since AE will not accept scripted
gradient stops anyway, the stop list is all that is needed.

### Webfonts are the biggest practical gap

Not a maths problem, and the most visible one: the layout was right to 0.235px
while the text was plainly wrong, because Instrument Serif was substituted by a
system sans that set wider and made the words collide.

Three separate causes, each of which hid the next:

1. **The browser downloads WOFF2**, which macOS Font Book will not install.
   Google Fonts serves the same faces as TrueType to clients it does not
   recognise, so re-requesting the stylesheet with **no User-Agent** yields
   installable `.ttf` files. (A modern UA gives woff2; an old Safari UA gives
   woff; an ancient MSIE UA gives nothing usable.)
2. **Assigning `TextDocument.fontFamily` does not take** in AE 2026: the value
   silently stays put. Setting the PostScript name works, and
   `app.fonts.getFontsByFamilyNameAndStyleName()` resolves it. Note that
   `app.fonts.allFonts` entries do not expose `familyName` to a `for...in`
   walk, so scanning that list to check availability reports a false negative --
   which sent this investigation down a blind alley for a while.
3. **Many families ship only Regular and Italic.** A heading computes to weight
   700, so a bold-only candidate list matches nothing and the text falls back
   silently. Walk the weight-appropriate styles first, then every common style,
   and report the substitution rather than hiding it.

With all three handled, the imported comp is visually indistinguishable from the
browser apart from the flat-gradient approximation.

## Rendering and cameras: three more instruments that lied

### comp.saveFrameToPng ignores the effect chain

A 40px Gaussian blur on a solid renders perfectly sharp through
`saveFrameToPng`, and 3D layers are not composed through the comp's camera. It
is a draft path. Using it for visual verification means checking the import
against a picture After Effects would never produce, and it hid both a missing blur
and a badly mis-projected 3D layer here.

The real render path is the **render queue**. There is no PNG output template in
a default install, so render `TIFF Sequence with Alpha` and convert with `sips`,
which is already on every Mac.

### A camera at the bottom of the stack is not used

After Effects renders a 3D layer through the first camera **above** it. Because
`comp.layers.addShape()` inserts at the top, a camera created before the layers
ends up at the bottom, where `comp.activeCamera` still names it and nothing is
actually drawn through it. Move it to the top once the layers exist.

### AE maps the camera's own position to the COMP CENTRE

This is the one that matters most, and it is easy to get backwards. Placing the
camera on the CSS perspective origin drags the whole 3D scene by
`cameraXY - compCentre`. Measured on the test panel: the projected SIZE was
correct to the pixel (300x213 in both browser and AE) while the centre sat at
(610, 400) instead of (830, 160), an offset of exactly (220, -240), which is
exactly `cameraXY - compCentre`.

So the camera belongs at the comp centre. That makes a layer on the z = 0 plane
land 1:1, and the whole-frame pixel difference against the browser dropped from
11.3% to 0.6%.

What centring the camera does NOT fix: CSS's vanishing point is
`perspective-origin`, AE's is the comp centre, and no camera placement
reconciles them. Anything off the z = 0 plane drifts in proportion to its depth.

### The fix: a composition centred on the perspective origin

`src/ir/precomp.mjs` lifts the perspective container's subtree into its own
composition, sized symmetrically about the perspective origin so that the comp
centre IS that origin. The camera goes at the centre, where AE's vanishing point
already is, and the two models coincide exactly. The precomp is then placed back
in the parent comp with its anchor at that centre and its position on the
origin, so it lands exactly where the subtree used to be.

Three details that matter:

- **The container loses its parent**, which stayed behind in the outer comp, so
  its position has to be rebased from parent-relative to absolute-plus-shift.
  That is why `aeTransformAt` also returns an `absolutePosition`.
- **Sizing needs every layer's box, not just shapes.** Sizing from shape extents
  alone omitted all the text and produced a 78x146 comp for a lower third that
  needed 958x178.
- **The precomp layer is structural** and must be excluded from numeric
  verification: it sits on the perspective origin by construction, not on the
  element's animated position, and checking it compares two different things.

Measured result, the 3D panel's rendered bounding box:

```
After Effects   [680, 54, 300, 213]   centre [830, 160.5]
browser         [680, 54, 300, 213]   centre [830, 160.5]
```

and the whole-frame pixel difference against the browser fell from 11.3% (before
any camera work) to 1.2%.

### Repeat Edge Pixels must be OFF on an imported blur

CSS `filter: blur()` fades an element's edges outward. AE's Gaussian Blur with
Repeat Edge Pixels ON holds them hard, and on a flat-coloured box that makes
the entire effect a no-op, rendering identically to an unblurred layer. It looks
exactly like the effect was never applied.

## overflow: hidden

CSS clips descendants to the **padding box** with the INNER border-radius (the
outer radius less the border). The element's own background and border are not
clipped by its own overflow, so they stay in the outer composition while only
the descendants move into a clipping comp.

Rebasing follows the same rule as the perspective precomp, with one wrinkle: only
the clipper's DIRECT children lost their parent, so only they are rebased to
absolute-plus-shift. Deeper descendants kept parents that came along and their
parent-relative positions are already correct.

A clip that clips nothing is skipped: clipping is a no-op then, and it would
cost a composition for no change in the picture.

### Two measuring mistakes this exposed

Both looked like importer bugs and were not:

- **The shift belongs to the COMPOSITION, not the layer.** `sourcePointToComp`
  reports a position in the comp the layer lives in, and that comp's coordinates
  are page coordinates plus its shift, true for every layer inside it, whether
  or not that layer's own stored position was rebased. Applying it only to
  rebased layers left every deeper descendant reporting exactly the clip offset.
- **`sourcePointToComp` maps through the layer transform only, never effects.**
  A CSS skew is carried by a Transform effect, because AE layers have no skew
  term, so the expectation has to drop the shear too. Otherwise every skewed
  layer reports an error equal to the skew's own contribution
  (tan(18°) x 130 = 42.25px here) while rendering perfectly.

### And one real bug

The AE Transform effect's properties are not in the order the names suggest:

```
-0001 Anchor Point   -0002 Position   -0005 Skew
-0006 Skew Axis      -0007 Rotation
```

The skew angle was going to `-0007`, which ROTATES the layer instead of shearing
it. The effect also pivots on its own anchor point, which defaults to the layer
centre rather than the CSS transform-origin, so both it and Position are now set
to the transform-origin.

## Group opacity

CSS `opacity` below 1 establishes a stacking context: element and descendants
render together, then the group fades as one. After Effects propagates nothing
through parenting, so the fade has to be applied to a composited result.

Baking the group's opacity into each descendant is the tempting shortcut and it
is wrong: two overlapping children each at, say, 50% produce an overlap at 75%,
where the design wants 50% everywhere. Compositing first is the only faithful
answer.

Mechanics, which mirror the clip comp with two differences:

- **The element itself goes INSIDE** the comp (CSS fades the element together
  with its descendants), where the clip comp deliberately leaves it outside.
- **The comp must not clip**, so it is sized to the subtree's full extent plus
  margin rather than to a box.

The element's own opacity is neutralised inside and moved to the wrapper, and
the layer is flagged `opacityHoisted` so verification looks for the fade where
it actually is. The wrapper is the one precomp worth checking numerically (it
carries the thing the feature exists to get right), so it is verified against
the source element's computed opacity rather than skipped like other structural
layers.

Ordering: fades are applied AFTER clipping, because CSS clips first and fades
the clipped result. The fade wrapper therefore contains the clip comp, not the
other way round.

Measured on a card fading in mid-animation, sampling a glyph pixel:

```
After Effects   [141, 139, 136]
browser         [140, 137, 134]
```

## Images

A footage layer's source is the file's natural pixel size, not the element's
box, so the fit is folded into the layer transform instead of costing another
composition. A source pixel `p` should land at `offset + p × fitScale` in the
element's box space and then go through the CSS transform, which rearranges to

```
scale  = cssScale × fitScale
anchor = (transformOrigin − offset) ÷ fitScale      (in source pixels)
```

`object-fit` and `background-size` share the same geometry (only the spelling
differs), so one `computeFit` covers `fill`, `contain`, `cover`, `none`,
`scale-down` and explicit background sizes. Where a fit deliberately overflows
(`cover`, an oversized `none`), CSS clips to the box and AE does not, so the
layer gets a rectangular mask **in source pixels**, which is the space a mask
lives in.

A `background-image` is a separate piece of artwork from the element carrying
it: the element still paints its own colour and border, and the bitmap becomes a
child layer masked to the padding box with the inner radius.

### Two things that bit

- **A .dc.html project's images do not load at all** without help. The artboard
  is rendered via `setContent` on `about:blank`, which has no base URL, so a
  relative `src` resolves to nothing and the image arrives 0×0 with no error.
  They are inlined as data URIs first, which is also how Claude Design's own
  runtime resolves them.
- **Compositions must be topologically sorted**, not emitted in creation order.
  Unshifting each new comp as it is built looked right until a fade comp created
  after a clip comp turned out to CONTAIN it: the fade was then built first and
  found no clip comp to place. `missing precomp clip-5`.

And one more measuring correction, the seventh: a layer inside a nested comp
reports its position in THAT comp's coordinates, so the expectation has to stop
composing at the comp's boundary element. Composing the full page chain counted
an ancestor's `translateY(40px)` that is applied outside the comp, and blamed the
importer for 40px it had not moved.

## Canvas and WebGL rasters

A canvas is just an image whose source changes every frame, so once the pixels
are captured it reuses the whole image path: the intrinsic buffer is stretched
to the CSS box, which is `object-fit: fill`.

### Reading a WebGL canvas fails silently

The drawing buffer is discarded at the end of the frame that drew it. Reading it
in a later task returns a blank image and **no error at all**; the capture
reports success and every frame is empty, which is the worst possible failure
mode. Measured on this Chromium:

```
same-task toDataURL   1526 bytes   (the triangle)
later-task toDataURL   806 bytes   (blank)
```

Both defences are applied because each has a hole:

- `getContext` is patched to force `preserveDrawingBuffer: true`. This cannot
  help a context created before the patch runs.
- The probe snapshots canvases inside the SAME task as the rAF flush that drew
  them, which is correct regardless of context attributes.

### A broken shader is a warning, not an error

WebGL reports a link failure through `console.warn` and then draws nothing, so a
blank canvas looks identical to a working one that happens to be empty. Those
messages are promoted into the report. This is not hypothetical: the fixture
written for this feature had a precision mismatch on a uniform shared between
the vertex and fragment shaders (`highp` vs `mediump`), which fails to link, and
the canvas captured 31 frames of pure clear-colour before that surfaced.

### And a real bug it exposed

Rounded corners clip even when nothing overflows the RECTANGLE. The clip comp
was being skipped whenever content fitted the box, which loses every rounded
frame whose content is flush with it, the common case, and exactly what a
canvas filling its rounded container looks like.
