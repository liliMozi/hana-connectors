# Hana Connectors

Prebuilt connector packages for the Hana market. Each package points Hana at a
service's own official remote MCP server; this repository ships no server code
and no credentials.

## What is here

- `catalog.json` — the curated list: id, name, endpoint, auth style, icon and a
  one-line description. `pending` holds entries not published yet.
- `icons/` — each service's own icon, rendered to 256px. `icons/SOURCES.json`
  records where every icon came from.
- `packages/<id>/connector.json` — generated packages.
- `scripts/fetch-icons.mjs` — fetches icons from the services' own sites.
- `scripts/build.mjs` — probes every endpoint and packs it.

## Build

Both scripts need a Hana checkout, whose packer and OAuth discovery they reuse.

```bash
node scripts/fetch-icons.mjs --hana <path-to-hana>
node scripts/build.mjs --hana <path-to-hana> --tag <release-tag>
```

`build.mjs` sends one MCP `initialize` request to each endpoint and, when the
server asks for authorization, runs Hana's own OAuth discovery. An entry is
packed only when the probe agrees with its declared auth style:

| `auth` | Probe must show | In Hana |
| --- | --- | --- |
| `none` | the server answers without credentials | works after install |
| `oauth` | OAuth with dynamic client registration | one-click sign-in |
| `bearer` | the endpoint is reachable | the detail page asks for the declared key |

Results go to `reports/probe.json`. Packages, entry files and the records for
the market repository go to `dist/`.

A probe shows that a server is online and how it authenticates. It does not
prove that sign-in or a key works end to end; try a connector before relying
on it.

## Publishing

Upload `dist/*.zip` and `dist/*.entry.json` to a stable GitHub Release, then
add the records in `dist/market-records.json` to the market repository's
`registry.json` and `approvals.json` with the release tag.

## Trademarks

Service names and icons belong to their owners and are used only to identify
the service a connector reaches. These packages are not published or endorsed
by those services.
