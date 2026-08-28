// Downloads all 32 NFL team logos (public ESPN CDN, standard team badges)
// and pixelates them with the same recipe used for fantasy team logos, so
// they match visually. Saved once to assets/img/nfl/<ABBR>.png, keyed by
// the same team abbreviation Sleeper uses in player metadata — a fixed set
// that basically never changes, so this doesn't need to run on a schedule
// like the fantasy logos do. Re-run by hand if a team ever rebrands.

import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";

const OUTPUT_DIR = "assets/img/nfl";
const PIXEL_GRID = 22;
const OUTPUT_SIZE = 256;
const PALETTE_COLORS = 16;

// Sleeper's team abbreviations; ESPN's logo CDN accepts the lowercase form
// directly for all of these (including the aliasy ones like jax/was/lar).
const TEAMS = [
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE",
  "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC",
  "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG",
  "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS",
];

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  for (const team of TEAMS) {
    const outputPath = path.join(OUTPUT_DIR, `${team}.png`);

    const res = await fetch(`https://a.espncdn.com/i/teamlogos/nfl/500/${team.toLowerCase()}.png`);
    if (!res.ok) {
      console.warn(`skip ${team}: ${res.status}`);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());

    const small = await sharp(buf)
      .flatten({ background: "#131a22" }) // logos have transparent bg; give it a fill before quantizing
      .resize(PIXEL_GRID, PIXEL_GRID, { fit: "contain", background: "#131a22" })
      .png()
      .toBuffer();

    await sharp(small)
      .modulate({ saturation: 1.35 })
      .resize(OUTPUT_SIZE, OUTPUT_SIZE, { kernel: "nearest" })
      .png({ palette: true, colors: PALETTE_COLORS })
      .toFile(outputPath);

    console.log(`${team} -> ${outputPath}`);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
