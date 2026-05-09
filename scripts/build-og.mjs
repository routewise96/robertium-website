// Convert public/og/*.svg → public/og/*.png at 1200x630.
// Run via `npm run build-og`. PNGs are committed to the repo so Cloudflare
// Pages can serve them directly without sharp at deploy time.
import sharp from 'sharp';
import { readdir } from 'fs/promises';
import { join, basename } from 'path';

const SVG_DIR = 'public/og';
const PNG_DIR = 'public/og';

async function convertSvgToPng() {
  const files = await readdir(SVG_DIR);
  const svgFiles = files.filter((f) => f.endsWith('.svg'));

  console.log(`Converting ${svgFiles.length} SVG files to PNG...`);

  for (const file of svgFiles) {
    const svgPath = join(SVG_DIR, file);
    const pngName = basename(file, '.svg') + '.png';
    const pngPath = join(PNG_DIR, pngName);

    await sharp(svgPath)
      .resize(1200, 630, { fit: 'cover' })
      .png({ quality: 90, compressionLevel: 9 })
      .toFile(pngPath);

    console.log(`  ${file} -> ${pngName}`);
  }

  console.log('Done.');
}

convertSvgToPng().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
