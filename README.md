# Canvas Render

[![CI](https://github.com/cris-pen/canvas-render/actions/workflows/ci.yml/badge.svg)](https://github.com/cris-pen/canvas-render/actions/workflows/ci.yml)

Render Claude Design exports and HTML animations to ProRes, H.264 and PNG sequences, or rebuild them in After Effects as editable layers. From a Mac app, the command line, or panels in Premiere Pro and After Effects.

![Canvas Render with a lower third loaded: scenes on the left, the frame over a transparency checkerboard, a ruler with the board's sections and in/out marks, output presets on the right, and a queue showing a re-render that reused 80 of 144 frames](docs/app.png)

Built for editors who get sent Claude Design projects to fix up or finish. Drop the export in, scrub it, mark in and out, and render the files an edit actually needs: an alpha master to cut over picture, a review copy to send, a timeline that lands in Premiere with the board's sections already marked. When the client sends a revised export, only the frames that changed are rendered again.

## What it does

- **Opens what you're sent.** A Claude Design project .zip, a standalone .html export, a folder, or any HTML animation: CSS keyframes, Web Animations, GSAP, `requestAnimationFrame` and canvas. Every board in a project shows up as a scene. Empty boards are skipped, and boards that fail to load show the error from the board itself.
- **Edit formats.** ProRes 4444 and 4444 XQ with alpha, ProRes 422 HQ, H.264 and PNG sequences with alpha. Exact NTSC rates (23.976 is 24000/1001), sizes up to 3840 × 2160, everything tagged Rec. 709.
- **Motion blur.** Set the shutter angle and samples. Samples are spread across the shutter and averaged in premultiplied space, so edges over transparency stay clean.
- **Re-renders only what changed.** A quick low-resolution pass compares every frame with the last render. Changed frames are rendered and spliced into the existing ProRes master, and the rest is reused. In the screenshot, renaming an episode title re-rendered 64 frames and reused 80.
- **Timeline XML.** One sequence with every rendered scene end to end and the board's named sections as markers. Imports into Premiere Pro and DaVinci Resolve.
- **A scrubber that works like an editor.** Frame-accurate timecode, the board's sections on the ruler, I and O for in and out, arrow keys to step frames, up and down to jump between sections.
- **Batches.** Render every board in an export in one go, with presets for the usual deliverables.
- **Editable After Effects comps.** Instead of pixels, get a script that rebuilds each scene as shape, text and null layers with keyframes. See [After Effects](#after-effects).
- **Background plates.** Put a colour, a two-colour gradient or a still image behind a render that has no alpha, with presets including chroma green and blue. Optionally replace the design's own background fill. The preview shows the plate as you change it.

## Premiere Pro panel

<img src="docs/panel.png" alt="The Canvas Render panel in Premiere: an export with two scenes, output preset and frame rate, import options, and a finished render" width="300" align="right">

The panel lets you stay in Premiere. Choose an export, tick the scenes, pick a preset and press **Render and import**. The renders land in a **Canvas Render** bin, either as clips or as a sequence with the section markers. Render the same export again and the clips already in the bin are updated in place rather than imported twice.

Premiere blocks plain `http://` requests from panels on macOS, so the panel doesn't talk to the app over the network. It drops a small request file into the app's folder (`~/Library/Application Support/Canvas Render/mailbox`) and reads progress back the same way. That's why it needs full file system access, and why the Canvas Render app has to be open while you use it. If it isn't, the panel offers to open it.

<br clear="right">

## After Effects

Choose **After Effects (editable layers)** as the format, or the **After Effects layers** preset, and each scene becomes a `.jsx` that builds the comp when you run it in After Effects. Boxes come in as shape layers, text as text layers with the font, size, tracking and leading set, groups as nulls with parenting, and motion as keyframes whose eases match the CSS timing curves. Along the way it also handles:

- `clip-path` wipes (inset, circle, ellipse, polygon) as masks driven by Slider Controls on the clipping layer, so a wipe is one keyframed slider instead of a mask path to redraw.
- Letters animated one after another become one text layer with a text animator and a range selector per letter.
- SVG paths keep their own coordinates, and a path whose shape changes over time is keyed on the Path property. A stroke that draws on becomes Trim Paths.
- CSS 3D and `perspective()` become 3D layers and a comp camera.
- Gradients become Gradient Ramp effects. Ones with three or more stops come in as two-stop ramps unless you tick **Exact gradients**, which brings them in as bitmaps instead.
- Anything After Effects can't rebuild, like a 3D skew, is rendered on its own with alpha and placed as footage in the right spot. Canvas elements come in as image sequences.

Every conversion is checked against the browser before it's written: each layer's keyframes are replayed against the measured position of its element on every frame. The queue shows how many layers came in, and a note for anything that was approximated or rendered as footage. The fonts the scene uses are copied to a `fonts` folder beside the script, so you can install any you're missing first.

To bring a scene in, press **Open in After Effects** in the queue, or run the `.jsx` from **File > Scripts > Run Script File**. Keep the script and its `assets` folder together.

### After Effects panel

`panel/after-effects/Canvas Render.jsx` is a ScriptUI panel. Copy it into `/Applications/Adobe After Effects <version>/Scripts/ScriptUI Panels/`, restart After Effects, and open **Window > Canvas Render.jsx**. Choose an export, pick the scenes and press **Convert and import**. Earlier conversions are listed under **Recent** to import again. It uses the same mailbox as the Premiere panel, so the app has to be open, and After Effects needs **Settings > Scripting & Expressions > Allow Scripts to Write Files and Access Network** turned on.

## Install

You need a Mac, [Homebrew](https://brew.sh) and ffmpeg:

```sh
brew install ffmpeg
```

Then build the app from source:

```sh
git clone https://github.com/cris-pen/canvas-render.git
cd canvas-render
npm install
npm run app          # run it
npm run dist         # or build a .dmg in dist/
```

On first launch the app checks for ffmpeg and a render browser. If Google Chrome is installed it uses that. Otherwise it offers to download Chromium once (about 150 MB). The app isn't signed, so if you copy a built .dmg to another Mac, right-click the app and choose **Open** the first time.

For the Premiere panel (Premiere Pro 25.6 or later):

```sh
npm run panel        # builds release/com.crispenstanbach.canvas-render_premierepro.ccx
```

Double-click the .ccx to install it through Creative Cloud, or load `panel/manifest.json` in UXP Developer Tool. It shows up under **Window > UXP Plugins > Canvas Render**.

## Command line

The engine also runs on its own, which is handy for scripts and for 4K masters on a render machine:

```sh
npx canvas-render info  export.zip                          # list scenes, sizes, lengths and sections
npx canvas-render render export.zip --format prores4444 --rate 23.976
npx canvas-render render export.zip --scene "Lower Third" --size uhd --blur 180:16 --review
npx canvas-render render export.zip --format prores422hq --bg linear:160:#1e293b:#0b1120 --bg-replace
npx canvas-render render export.zip --format ae               # After Effects scripts
npx canvas-render serve --open                              # the app's UI in your browser
```

Run `npx canvas-render --help` for every option. Renders go to `~/Movies/Canvas Render/<project>` unless you pass `--out-dir`.

Try it on the included example: `npx canvas-render render examples/tidewater-export --review`.

## How it works

Each scene loads in headless Chromium with a virtual clock, so time only moves when the renderer says so. Claude Design boards are moved to each frame through their exportable-video contract: the stage is sized from its attributes and seeked with its `data-om-seek-to-time-frame` event. Ordinary pages run on the virtual clock, which drives timers, `requestAnimationFrame` and CSS animations in lockstep. Frames are captured at output resolution and piped into ffmpeg. Fonts and libraries from public CDNs are cached on disk, so a project that rendered once renders offline.

For After Effects, the same page is measured instead of photographed. On every frame a probe records each element's untransformed box, its transform matrix, origin and styles. Each matrix is decomposed into After Effects' model (anchor point, position, scale, rotation, 3D orientation), with any part it can't express flagged for the raster fallback. The per-frame values are then fitted with as few keyframes as stay within a quarter pixel, and CSS cubic-bezier curves are converted exactly into After Effects' speed and influence eases. The After Effects conversion builds on design-to-ae, an earlier converter by the same author.

## Status

- **Engine.** Tested in CI on Linux and macOS with real renders: ProRes 4444 with alpha, PNG sequences, motion blur, CSS and canvas pages, and a partial re-render checked frame by frame against a clean render. It has also rendered real Claude Design project exports correctly.
- **Mac app.** CI starts it on macOS, waits for the engine and the window, and builds the .dmg. It hasn't had much real-world use yet.
- **Premiere panel.** Tested against stand-ins for Premiere's API that talk to a real engine through the real mailbox: choosing an export, rendering, importing into bins, and re-rendering. It hasn't been run inside Premiere yet.
- **After Effects.** CI converts the example export and redraws the resulting layers in a browser with After Effects' transform rules, then compares them with the original frames pixel by pixel. The panel is tested the same way as the Premiere one, against stand-ins for ExtendScript and ScriptUI. The scripts haven't been run inside After Effects by CI.

## Limits

- **Share links.** Claude artifact links need you to be signed in, so the app can't fetch them. Open the artifact, choose **Export > Download as .zip**, and drop the zip in.
- **Audio.** Boards can carry audio, but it isn't mixed into renders yet.
- **Change detection resolution.** Frames are compared at 480 pixels wide. A very small, faint change, like a one-pixel line shifting slightly in color, can be missed. Turn off **Re-render only what changed** (or pass `--full`) for a clean render.
- **After Effects.** A line of text with differently styled words inside it (a `<b>`, a `<sup>`) comes in as separate pieces rather than one text layer with mixed styles. Animated font size and text colour use their first value. Web-only fonts (WOFF) can't be installed on a Mac, so the notes ask for the desktop version. Elliptical radial gradients become circular ramps of the same area. Kerning is matched in After Effects 24.0 and later.
- **Background plates.** Still images only, not video. **Replace** clears the board's top-level fill; a full-size background element inside the board stays.
- **Signing.** The app isn't signed or notarized yet. The CI build is for Apple silicon; on an Intel Mac, `npm run dist` builds an Intel copy.

## Development

```sh
npm test             # engine, server, panel, render and After Effects tests (needs ffmpeg and Chrome)
node scripts/ae-compare.mjs examples/tidewater-export /tmp/compare   # original | layers | difference, as PNGs
npm run serve        # the UI in a browser, against a live engine
```

| Folder | What's in it |
| --- | --- |
| `engine/` | Ingest, the virtual clock, capture, encoding, change detection, XML, the HTTP server and the panels' mailbox |
| `engine/src/ae/` | The After Effects conversion: the probe, transform analysis, keyframe fitting, the comp builder and the ExtendScript it writes |
| `ui/` | The app window: plain HTML, CSS and JavaScript served by the engine |
| `app/` | The Electron shell for macOS |
| `panel/` | The Premiere Pro UXP panel, and the After Effects ScriptUI panel in `panel/after-effects/` |
| `fixtures/`, `examples/` | Clean-room boards for tests and demos |

Canvas Render isn't made by or affiliated with Anthropic. Claude is a trademark of Anthropic.

## License

MIT
