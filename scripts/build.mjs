#!/usr/bin/env node
/**
 * Build Hana market connector packages from catalog.json.
 *
 *   node scripts/build.mjs --hana <path-to-hana-checkout> [--tag vYYYY.MM.DD] [--only id,id] [--no-probe]
 *
 * For every catalog entry this script
 *   1. validates the entry (safe id, https URL, declared auth, icon file);
 *   2. probes the live endpoint the way Hana itself connects to it: an MCP
 *      `initialize` request, then Hana's own OAuth discovery
 *      (core/mcp/clients/oauth.ts) when the server asks for authorization, so
 *      "supports dynamic client registration" means exactly what Hana sees;
 *   3. writes packages/<id>/connector.json plus its icon;
 *   4. packs it with Hana's scripts/extension-pack.mjs into dist/.
 *
 * An entry whose probe disagrees with its declared auth is reported and not
 * packed. Results land in reports/probe.json; registry and approval records
 * for the market repository land in dist/market-records.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISHER = "liliMozi";
const REPOSITORY = "liliMozi/hana-connectors";
const AUTH_TYPES = new Set(["none", "oauth", "bearer"]);
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROBE_TIMEOUT_MS = 20_000;

function parseArgs(argv) {
  const args = { probe: true, only: null, tag: "", hana: process.env.HANA_CHECKOUT || "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-probe") args.probe = false;
    else if (arg === "--hana") args.hana = argv[++i];
    else if (arg === "--tag") args.tag = argv[++i];
    else if (arg === "--only") args.only = new Set(argv[++i].split(",").map((s) => s.trim()).filter(Boolean));
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!args.hana) throw new Error("--hana <path-to-hana-checkout> (or HANA_CHECKOUT) is required");
  args.hana = path.resolve(args.hana);
  return args;
}

function readCatalog() {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "catalog.json"), "utf8"));
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.connectors)) {
    throw new Error("catalog.json must be { schemaVersion: 1, connectors: [...] }");
  }
  const seen = new Set();
  for (const [index, entry] of catalog.connectors.entries()) {
    const label = `catalog.connectors[${index}]`;
    if (!SAFE_ID.test(entry.id ?? "")) throw new Error(`${label}.id must be a safe lowercase id`);
    if (seen.has(entry.id)) throw new Error(`${label}.id ${entry.id} is duplicated`);
    seen.add(entry.id);
    for (const key of ["name", "description", "url", "version", "icon"]) {
      if (typeof entry[key] !== "string" || !entry[key].trim()) throw new Error(`${label}.${key} is required`);
    }
    if (new URL(entry.url).protocol !== "https:") throw new Error(`${label}.url must use https`);
    if (!AUTH_TYPES.has(entry.auth)) throw new Error(`${label}.auth must be none, oauth or bearer`);
    if (!/^\d+\.\d+\.\d+$/.test(entry.version)) throw new Error(`${label}.version must be x.y.z`);
    if (!fs.existsSync(path.join(ROOT, entry.icon))) throw new Error(`${label}.icon ${entry.icon} does not exist`);
    if (entry.auth === "bearer" && !entry.credentials?.some((item) => item?.target?.type === "bearer")) {
      throw new Error(`${label}: a bearer connector must declare its bearer credential so Hana can ask for it`);
    }
  }
  return catalog.connectors;
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

/** Classify a live endpoint: open | oauth-dcr | oauth-manual | auth-required | error. */
async function probe(entry, discoverMcpOAuth) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "hana-connectors-probe", version: "1.0.0" },
    },
  });
  let response;
  try {
    response = await fetchWithTimeout(entry.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body,
    });
  } catch (error) {
    return { status: "error", detail: error instanceof Error ? error.message : String(error) };
  }
  const httpStatus = response.status;
  try { await response.body?.cancel(); } catch { /* the body is not needed */ }
  if (httpStatus >= 200 && httpStatus < 300) return { status: "open", httpStatus };
  if (httpStatus !== 401 && httpStatus !== 403) return { status: "error", httpStatus, detail: `unexpected HTTP ${httpStatus}` };
  try {
    const discovered = await discoverMcpOAuth({
      connectorUrl: entry.url,
      fetchImpl: (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }),
    });
    return discovered.registrationEndpoint
      ? { status: "oauth-dcr", httpStatus, authorizationServer: discovered.authorizationServer }
      : { status: "oauth-manual", httpStatus, authorizationServer: discovered.authorizationServer };
  } catch (error) {
    return { status: "auth-required", httpStatus, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Whether a probe result supports the auth the catalog declares. */
function probeMatches(entry, result) {
  if (entry.auth === "none") return result.status === "open";
  if (entry.auth === "oauth") return result.status === "oauth-dcr";
  // A bearer server may accept `initialize` without credentials and check the
  // key only on tool calls, so an open handshake also fits.
  return result.status !== "error";
}

function writePackage(entry) {
  const dir = path.join(ROOT, "packages", entry.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const iconName = `icon${path.extname(entry.icon)}`;
  fs.copyFileSync(path.join(ROOT, entry.icon), path.join(dir, iconName));
  const spec = {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    transport: "streamable-http",
    url: entry.url,
    authType: entry.auth,
    version: entry.version,
    icon: iconName,
    // Validated again by Hana's extension-pack, which rejects malformed declarations.
    ...(entry.credentials ? { credentials: entry.credentials } : {}),
  };
  fs.writeFileSync(path.join(dir, "connector.json"), `${JSON.stringify(spec, null, 2)}\n`);
  return dir;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { packExtension } = await import(pathToFileURL(path.join(args.hana, "scripts", "extension-pack.mjs")).href);
  const { discoverMcpOAuth } = await import(pathToFileURL(path.join(args.hana, "core", "mcp", "clients", "oauth.ts")).href);
  const entries = readCatalog().filter((entry) => !args.only || args.only.has(entry.id));
  const outDir = path.join(ROOT, "dist");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const report = [];
  const records = { registry: [], approvals: [] };
  for (const entry of entries) {
    const result = args.probe ? await probe(entry, discoverMcpOAuth) : { status: "skipped" };
    const matches = !args.probe || probeMatches(entry, result);
    const row = { id: entry.id, auth: entry.auth, url: entry.url, probe: result, packed: false };
    if (!matches) {
      row.reason = `declared auth ${entry.auth} does not match probe ${result.status}`;
      report.push(row);
      console.warn(`skip ${entry.id}: ${row.reason}${result.detail ? ` (${result.detail})` : ""}`);
      continue;
    }
    const dir = writePackage(entry);
    const packed = await packExtension({ kind: "connector", dir, publisher: PUBLISHER, out: outDir });
    row.packed = true;
    row.zip = path.basename(packed.zipPath);
    row.sha256 = packed.entry.archive.sha256;
    report.push(row);
    records.registry.push({ kind: "connector", id: entry.id, repository: REPOSITORY, publisher: PUBLISHER });
    records.approvals.push({ kind: "connector", id: entry.id, tag: args.tag || "<release-tag>", sha256: packed.entry.archive.sha256 });
    console.log(`packed ${entry.id} (${result.status})`);
  }

  fs.mkdirSync(path.join(ROOT, "reports"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "reports", "probe.json"), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "market-records.json"), `${JSON.stringify(records, null, 2)}\n`);
  const packedCount = report.filter((row) => row.packed).length;
  console.log(`\n${packedCount}/${report.length} connectors packed; see reports/probe.json`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
