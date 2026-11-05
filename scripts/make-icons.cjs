// Renders the app and panel icons from app/build/icon.svg.
// Run after changing the SVG: node scripts/make-icons.cjs
const path = require('node:path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const svg = path.join(root, 'app', 'build', 'icon.svg');

(async () => {
  await sharp(svg, { density: 144 }).resize(1024, 1024).png().toFile(path.join(root, 'app', 'build', 'icon.png'));
  await sharp(svg, { density: 72 }).resize(256, 256).png().toFile(path.join(root, 'docs', 'icon-256.png'));
  // The panel list icon is small, so it drops the squircle and keeps the frame and playhead.
  const crop = { left: 180, top: 230, width: 664, height: 560 };
  const big = await sharp(svg, { density: 144 }).resize(1024, 1024).png().toBuffer();
  const frame = await sharp(big).extract(crop).png().toBuffer();
  for (const [name, size] of [['plugin.png', 24], ['plugin@1x.png', 24], ['plugin@2x.png', 48]]) {
    await sharp(frame).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png().toFile(path.join(root, 'panel', 'icons', name));
  }
  console.log('icons written');
})();
