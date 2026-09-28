from __future__ import annotations

from pathlib import Path


def publish_r2(zip_path: Path, filename: str, config: dict) -> str:
    import boto3

    endpoint = config.get("endpoint_url", "").strip()
    access = config.get("access_key_id", "").strip()
    secret = config.get("secret_access_key", "").strip()
    bucket = config.get("bucket", "").strip()
    base = config.get("public_base_url", "").rstrip("/")
    if not all([endpoint, access, secret, bucket, base]):
        raise RuntimeError("R2 publishing is enabled but publishing settings are incomplete in config.json")

    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access,
        aws_secret_access_key=secret,
        region_name="auto",
    )
    key = filename
    client.upload_file(
        str(zip_path),
        bucket,
        key,
        ExtraArgs={"ContentType": "application/zip", "CacheControl": "public, max-age=31536000, immutable"},
    )
    return f"{base}/{key}"


def maybe_publish(zip_path: Path, filename: str, config: dict) -> str | None:
    pub = config.get("publishing", {})
    if not pub.get("enabled", False):
        return None
    provider = pub.get("provider", "r2")
    if provider == "r2":
        return publish_r2(zip_path, filename, pub)
    raise RuntimeError(f"Unknown publishing provider: {provider}")
