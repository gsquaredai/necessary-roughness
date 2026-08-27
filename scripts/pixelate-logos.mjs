// Downloads each team's current Sleeper logo/profile pic into
// assets/img/teams/source/ (for reference, or as raw material if you want to
// hand-edit them), then auto-pixelates a copy into assets/img/teams/<ownerId>.png
// — the exact path the site already looks for as a logo override, so this
// takes effect immediately with no other changes.
//
// Re-run any time (e.g. after fetch-sleeper.mjs pulls new team logos) to
// refresh the pixelated versions. Only touches teams that don't already have
// a hand-made override — see FORCE below to bulk-regenerate everyone.

import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";

const FORCE = process.argv.includes("--force");
const PIXEL_GRID = 16; // how blocky — smaller = chunkier pixels
const OUTPUT_SIZE = 256;
const PALETTE_COLORS = 16;

const SOURCE_DIR = "assets/img/teams/source";
const OUTPUT_DIR = "assets/img/teams";

async function main() {
  const idx = JSON.parse(await fs.readFile("data/index.json", "utf8"));
  const season = JSON.parse(
    await fs.readFile(`data/${idx.currentSeason}.json`, "utf8")
  );

  await fs.mkdir(SOURCE_DIR, { recursive: true });

  for (const team of season.teams) {
    if (!team.ownerId || !team.avatar) continue;

    const outputPath = path.join(OUTPUT_DIR, `${team.ownerId}.png`);
    if (!FORCE) {
      const exists = await fs
        .access(outputPath)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        console.log(`skip ${team.teamName} (already has an override)`);
        continue;
      }
    }

    console.log(`fetching ${team.teamName} <- ${team.avatar}`);
    const res = await fetch(team.avatar);
    if (!res.ok) {
      console.warn(`  failed: ${res.status}`);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());

    const contentType = res.headers.get("content-type") || "";
    const ext = contentType.includes("png")
      ? "png"
      : contentType.includes("webp")
      ? "webp"
      : "jpg";
    const sourcePath = path.join(SOURCE_DIR, `${team.ownerId}.${ext}`);
    await fs.writeFile(sourcePath, buf);

    await sharp(buf)
      .resize(PIXEL_GRID, PIXEL_GRID, { fit: "cover", position: "centre" })
      .modulate({ saturation: 1.35 })
      .resize(OUTPUT_SIZE, OUTPUT_SIZE, { kernel: "nearest" })
      .png({ palette: true, colors: PALETTE_COLORS })
      .toFile(outputPath);

    console.log(`  -> ${outputPath}`);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
