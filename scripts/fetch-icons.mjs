#!/usr/bin/env node
/**
 * Fetch each service's own colored icon from its homepage.
 *
 *   node scripts/fetch-icons.mjs --hana <path-to-hana-checkout> [--only id,id] [--force]
 *
 * Candidates come from the homepage's <link rel="apple-touch-icon">,
 * <link rel="icon"> and web manifest icons (mask-icon is skipped: it is a
 * single-color silhouette). The largest raster or SVG wins; it is rendered
 * to a 256px square PNG with transparent padding. Every chosen source URL is
 * written to icons/SOURCES.json for review. A service whose homepage offers
 * nothing usable is reported, not filled in from elsewhere.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = 256;
const TIMEOUT_MS = 20_000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

function parseArgs(argv) {
  const args = { only: null, force: false, hana: process.env.HANA_CHECKOUT || "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--force") args.force = true;
    else if (argv[i] === "--hana") args.hana = argv[++i];
    else if (argv[i] === "--only") args.only = new Set(argv[++i].split(","));
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.hana) throw new Error("--hana <path-to-hana-checkout> (or HANA_CHECKOUT) is required");
  return args;
}

async function get(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow", headers: { "user-agent": UA } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { url: response.url, type: response.headers.get("content-type") || "", body: Buffer.from(await response.arrayBuffer()) };
  } finally {
    clearTimeout(timer);
  }
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? (match[2] ?? match[3] ?? match[4] ?? "") : "";
}

function sizeOf(sizes) {
  const values = String(sizes || "").split(/\s+/).map((s) => Number(s.split("x")[0])).filter(Number.isFinite);
  return values.length ? Math.max(...values) : 0;
}

async function candidatesFor(homepage) {
  const page = await get(homepage);
  const html = page.body.toString("utf8");
  const base = page.url;
  const found = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const rel = attr(tag, "rel").toLowerCase();
    const href = attr(tag, "href");
    if (!href || rel.includes("mask-icon")) continue;
    if (rel.includes("apple-touch-icon")) found.push({ url: new URL(href, base).href, size: sizeOf(attr(tag, "sizes")) || 180, kind: "apple-touch-icon" });
    else if (rel.split(/\s+/).includes("icon")) {
      const type = attr(tag, "type");
      const isSvg = type.includes("svg") || /\.svg(\?|$)/i.test(href);
      found.push({ url: new URL(href, base).href, size: isSvg ? 1024 : sizeOf(attr(tag, "sizes")) || 32, kind: isSvg ? "svg-icon" : "icon" });
    } else if (rel === "manifest") {
      try {
        const manifestUrl = new URL(href, base).href;
        const manifest = JSON.parse((await get(manifestUrl)).body.toString("utf8"));
        for (const icon of manifest.icons || []) {
          if (String(icon.purpose || "").includes("monochrome")) continue;
          found.push({ url: new URL(icon.src, manifestUrl).href, size: sizeOf(icon.sizes) || 192, kind: "manifest" });
        }
      } catch { /* a broken manifest just contributes nothing */ }
    }
  }
  found.push({ url: new URL("/apple-touch-icon.png", base).href, size: 180, kind: "apple-touch-icon (conventional)" });
  return found.sort((a, b) => b.size - a.size);
}

/**
 * Favicons are often .ico files. Most modern ones embed PNG images; take the
 * largest embedded PNG. BMP-only entries are not decoded.
 */
function largestIcoEntry(body) {
  if (body.length < 6 || body.readUInt16LE(0) !== 0 || body.readUInt16LE(2) !== 1) return null;
  const count = body.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16;
    if (at + 16 > body.length) break;
    const width = body[at] || 256;
    const size = body.readUInt32LE(at + 8);
    const offset = body.readUInt32LE(at + 12);
    const data = body.subarray(offset, offset + size);
    if (data.length && (!best || width > best.width)) best = { width, data };
  }
  return best;
}

/** A 32-bit BGRA DIB from an .ico entry, as sharp raw input. Other bit depths are not decoded. */
function rawFromIcoBitmap(data) {
  if (data.length < 40 || data.readUInt32LE(0) !== 40) return null;
  const width = data.readInt32LE(4);
  const height = data.readInt32LE(8) / 2;
  const bpp = data.readUInt16LE(14);
  if (bpp !== 32 || width <= 0 || height <= 0) return null;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const src = 40 + (height - 1 - y) * width * 4;
    for (let x = 0; x < width; x += 1) {
      const s = src + x * 4;
      const d = (y * width + x) * 4;
      pixels[d] = data[s + 2];
      pixels[d + 1] = data[s + 1];
      pixels[d + 2] = data[s];
      pixels[d + 3] = data[s + 3];
    }
  }
  return { pixels, width, height };
}

async function render(sharp, rawBody) {
  const entry = largestIcoEntry(rawBody);
  let image;
  if (entry) {
    const isPng = entry.data[0] === 0x89 && entry.data[1] === 0x50;
    const raw = isPng ? null : rawFromIcoBitmap(entry.data);
    if (!isPng && !raw) throw new Error("ico entry is not PNG or 32-bit BMP");
    image = isPng
      ? sharp(entry.data)
      : sharp(raw.pixels, { raw: { width: raw.width, height: raw.height, channels: 4 } });
  } else {
    image = sharp(rawBody, { density: 384, limitInputPixels: 64_000_000 });
  }
  const meta = await image.metadata();
  if (!meta.width || !meta.height) throw new Error("no dimensions");
  const longest = Math.max(meta.width, meta.height);
  // Below 64px an upscaled icon is visibly blurred; 64-95px passes and is
  // flagged by its recorded sourceSize for later replacement.
  if (meta.format !== "svg" && longest < 64) throw new Error(`too small (${longest}px)`);
  const png = await image
    .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }, withoutEnlargement: false })
    .png()
    .toBuffer();
  return { png, sourceSize: longest, format: meta.format };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sharp = createRequire(path.join(path.resolve(args.hana), "package.json"))("sharp");
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "catalog.json"), "utf8"));
  const sourcesPath = path.join(ROOT, "icons", "SOURCES.json");
  const sources = fs.existsSync(sourcesPath) ? JSON.parse(fs.readFileSync(sourcesPath, "utf8")) : {};
  const byIcon = new Map();
  for (const entry of catalog.connectors) {
    if (args.only && !args.only.has(entry.id)) continue;
    if (!byIcon.has(entry.icon)) byIcon.set(entry.icon, entry);
  }
  const failures = [];
  for (const [iconPath, entry] of byIcon) {
    const target = path.join(ROOT, iconPath);
    if (fs.existsSync(target) && !args.force) continue;
    let done = false;
    let lastError = "no candidates";
    try {
      // `iconPage` names another page of the same vendor when the homepage
      // offers no usable icon (a developer site, a docs site).
      const explicit = entry.iconUrl ? [{ url: entry.iconUrl, size: Infinity, kind: "iconUrl" }] : [];
      let discovered = [];
      try { discovered = await candidatesFor(entry.iconPage || entry.homepage); } catch (error) {
        if (!explicit.length) throw error;
      }
      for (const candidate of [...explicit, ...discovered]) {
        try {
          const { body } = await get(candidate.url);
          const { png, sourceSize, format } = await render(sharp, body);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, png);
          sources[path.basename(iconPath)] = { from: candidate.url, kind: candidate.kind, format, sourceSize };
          console.log(`${path.basename(iconPath)} <- ${candidate.url} (${format}, ${sourceSize}px)`);
          done = true;
          break;
        } catch (error) {
          lastError = `${candidate.url}: ${error instanceof Error ? error.message : error}`;
        }
      }
    } catch (error) {
      lastError = `${entry.iconPage || entry.homepage}: ${error instanceof Error ? error.message : error}`;
    }
    if (!done) failures.push(`${path.basename(iconPath)} (${lastError})`);
  }
  fs.writeFileSync(sourcesPath, `${JSON.stringify(Object.fromEntries(Object.entries(sources).sort()), null, 2)}\n`);
  if (failures.length) {
    console.warn(`\nno usable icon for:\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
