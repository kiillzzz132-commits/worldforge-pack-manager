# WorldForge Resource Merger

A free, browser-native Minecraft resource-pack merger.

## What it does

- Accepts **two complete resource-pack ZIPs**
- Reads and merges them **locally in the browser**
- Preserves files found only in the older pack
- Adds files found only in the newer pack
- Detects unchanged files by ZIP metadata
- Smart-merges Minecraft JSON where appropriate:
  - font providers
  - sounds
  - language JSON
  - atlases
  - tags
  - `pack.mcmeta`
- Lets the user choose **NEW** or **OLD** for true conflicts
- Supports ZIP64
- Uses compressed pass-through copying when possible for speed
- Includes optional **Large Pack Mode** on Chromium browsers to write directly to disk
- Calculates Minecraft's exact SHA-1 locally
- Creates a downloadable merge report
- Shows official release history from GitHub Releases

## Free architecture

The live website is intended for **Cloudflare Pages**. It is a static site, so it does not need a paid application server.

The actual pack merging happens on the visitor's device. The resource-pack ZIPs are never uploaded to Cloudflare.

Official downloadable versions are stored as **GitHub Release assets** rather than as website files.

## Cloudflare Pages deployment

Use these settings when connecting this repository:

- Production branch: `main`
- Framework preset: **None**
- Build command: `exit 0`
- Build output directory: `.`

The project receives a free `*.pages.dev` address after deployment.

## Publishing an official pack version

1. Merge the two complete packs on the website.
2. Download/save the merged ZIP.
3. Use **Copy release notes** on the result screen.
4. In GitHub open **Releases → Draft a new release**.
5. Create a tag such as `v1`, `v2`, or `v3`.
6. Upload the merged ZIP as the release asset.
7. Paste the generated release notes.
8. Publish the release.

The website's **Downloads** tab automatically reads published releases and shows the latest pack plus all previous versions.

> The repository must be public for anonymous visitors to download public GitHub Release assets and for the website to query the release list without a private token.

## Libraries

The static app uses:

- `@zip.js/zip.js` 2.18.2 for ZIP/ZIP64 processing
- `hash-wasm` 4.12.0 for streaming SHA-1

No application-server runtime is required.
