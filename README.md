# WorldForge Pack Manager

Minecraft-aware web tool that accepts **two complete resource-pack ZIPs** and produces one merged pack.

## Features
- Upload an older complete pack and a newer complete pack
- Safe ZIP extraction and corrupt-archive detection
- Smart merging for fonts, sounds, language files, atlases, tags and `pack.mcmeta`
- Conflict review with **Use NEW / Keep OLD**
- Finished-pack validation
- Automatic SHA-1 generation
- Ready-to-paste `server.properties`
- Downloadable merged ZIP
- Optional Cloudflare R2 publishing for durable public URLs
- Railway-ready Docker deployment

## Deploy on Railway
1. Create a Railway project and choose **Deploy from GitHub repo**.
2. Select this repository.
3. Railway uses `Dockerfile` and `railway.json`.
4. Generate a public domain in Networking.
5. Open `/health` and confirm it returns `{"ok": true}`.

Railway injects `PORT`; this app automatically listens on `0.0.0.0:$PORT` when hosted.

## Optional Cloudflare R2 publishing
Set these Railway variables:
- `R2_ENDPOINT_URL`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`
- `R2_PUBLIC_BASE_URL`

When all five are present, hosted builds publish to R2 automatically.

## Local development
```bash
python app.py
```

Run tests:
```bash
python -m unittest discover -s tests -v
```

Without R2, generated ZIPs/history are stored on the web-service filesystem and can disappear on redeploy/restart. Configure R2 for durable public downloads.
