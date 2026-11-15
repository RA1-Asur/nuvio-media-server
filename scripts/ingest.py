#!/usr/bin/env python3
"""
Nuvio Cloud Vault - Video Ingestion Engine
Downloads video using yt-dlp (with aria2c acceleration if available),
extracts rich metadata, sanitizes filenames, uploads to Internet Archive
with --no-derive, and maintains catalog_index.json.
"""

import os
import sys
import json
import re
import glob
import time
import shutil
import hashlib
import argparse
import urllib.parse
import urllib.request
import ssl
from datetime import datetime, timezone
import subprocess

try:
    import requests
except ImportError:
    print("[ERROR] 'requests' package not installed. Run: pip install requests")
    sys.exit(1)

try:
    import internetarchive as ia
except ImportError:
    print("[ERROR] 'internetarchive' package not installed. Run: pip install internetarchive")
    sys.exit(1)


def detect_remote_title(video_url):
    """
    Attempts to extract human-readable title from Content-Disposition header
    when downloading direct video files.
    """
    try:
        req = urllib.request.Request(
            video_url, 
            method="HEAD", 
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
        )
        # Avoid SSL certificate validation issues on legacy environments
        ctx = ssl._create_unverified_context()
        with urllib.request.urlopen(req, context=ctx, timeout=8) as resp:
            cd = resp.headers.get("Content-Disposition", "")
            if cd:
                match = re.search(r'filename\*?=(?:UTF-8\'\')?\"?([^\";]+)\"?', cd, re.IGNORECASE)
                if match:
                    raw_fn = urllib.parse.unquote(match.group(1).strip())
                    title = re.sub(r'\.[a-zA-Z0-9]+$', '', raw_fn)
                    clean_title = re.sub(r'[_.]+', ' ', title).strip()
                    if clean_title:
                        print(f"[INFO] Extracted title from Content-Disposition header: '{clean_title}'")
                        return clean_title
    except Exception as e:
        print(f"[DEBUG] Remote title detection skipped: {e}")
    return None
    parser.add_argument("--custom-title", default=os.environ.get("CUSTOM_TITLE"), help="Optional custom title override")
    parser.add_argument("--imdb-id", default=os.environ.get("IMDB_ID"), help="Optional IMDb ID (e.g. tt1234567)")
    parser.add_argument("--poster-url", default=os.environ.get("POSTER_URL"), help="Optional thumbnail or poster URL")
    parser.add_argument("--ia-item-id", default=os.environ.get("IA_ITEM_ID", "nuvio-cloud-vault-2026"), help="Internet Archive Item Identifier")
    parser.add_argument("--temp-dir", default="./downloads", help="Temporary working directory for downloads")
    return parser.parse_args()


def format_duration(seconds):
    if not seconds:
        return "Unknown"
    try:
        s = int(seconds)
        hours = s // 3600
        minutes = (s % 3600) // 60
        secs = s % 60
        if hours > 0:
            return f"{hours}h {minutes:02d}m"
        return f"{minutes}m {secs:02d}s"
    except Exception:
        return "Unknown"


def download_video(video_url, temp_dir):
    """
    Downloads video and metadata using yt-dlp with aria2c if available.
    """
    os.makedirs(temp_dir, exist_ok=True)
    out_tmpl = os.path.join(temp_dir, "video_%(id)s.%(ext)s")

    cmd = [
        sys.executable, "-m", "yt_dlp",
        "--write-info-json",
        "--write-thumbnail",
        "--no-playlist",
        "--format", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "--merge-output-format", "mp4",
        "-o", out_tmpl,
        "--no-check-certificates",
        "--extractor-args", "youtube:player_client=android,web,ios",
        video_url
    ]

    # Check for aria2c acceleration
    if shutil.which("aria2c"):
        print("[INFO] aria2c detected. Enabling multi-connection download acceleration.")
        cmd.extend([
            "--downloader", "aria2c",
            "--downloader-args", "aria2c:-s 16 -x 16 -k 1M -j 16"
        ])
    else:
        print("[INFO] aria2c not found. Using default yt-dlp downloader.")

    print(f"[INFO] Executing download: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"[ERROR] yt-dlp failed:\n{result.stderr}\n{result.stdout}")
        raise RuntimeError(f"Download failed with exit code {result.returncode}")

    # Locate downloaded info.json
    info_files = glob.glob(os.path.join(temp_dir, "video_*.info.json"))
    if not info_files:
        raise FileNotFoundError("Could not find yt-dlp generated .info.json file.")
    info_path = info_files[0]

    with open(info_path, "r", encoding="utf-8") as f:
        info_data = json.load(f)

    # Locate downloaded video file (exclude info.json and thumbnail images)
    all_files = glob.glob(os.path.join(temp_dir, "video_*"))
    video_files = [
        f for f in all_files 
        if not f.endswith(".info.json") and 
        not f.endswith(".jpg") and 
        not f.endswith(".webp") and 
        not f.endswith(".png") and
        not f.endswith(".part") and
        os.path.isfile(f)
    ]

    if not video_files:
        raise FileNotFoundError("Could not find downloaded video file in temp directory.")
    
    video_file = video_files[0]

    # Locate thumbnail file if downloaded
    thumb_files = [
        f for f in all_files 
        if (f.endswith(".jpg") or f.endswith(".webp") or f.endswith(".png")) and os.path.isfile(f)
    ]
    thumb_file = thumb_files[0] if thumb_files else None

    return video_file, info_data, thumb_file


def sanitize_filename(title, original_path):
    """
    Creates a clean, URL-safe filename without spaces or special symbols.
    """
    _, ext = os.path.splitext(original_path)
    if not ext:
        ext = ".mp4"

    clean_title = re.sub(r'[^a-zA-Z0-9_\-]', '_', title).strip('_')
    clean_title = re.sub(r'_+', '_', clean_title)
    if not clean_title:
        clean_title = "vault_video"

    # Truncate and append short deterministic hash
    short_hash = hashlib.md5(title.encode('utf-8')).hexdigest()[:8]
    clean_filename = f"{clean_title[:50]}_{short_hash}{ext}"
    return clean_filename, short_hash


def sync_catalog_index(ia_item_id, access_key, secret_key, new_entry):
    """
    Downloads existing catalog_index.json from Internet Archive,
    updates it with new video metadata, and re-uploads it.
    """
    catalog_url = f"https://archive.org/download/{ia_item_id}/catalog_index.json"
    print(f"[INFO] Fetching catalog index from: {catalog_url}")

    catalog = {
        "version": 1,
        "item_id": ia_item_id,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "items": []
    }

    try:
        res = requests.get(catalog_url, timeout=15)
        if res.status_code == 200:
            existing_data = res.json()
            if isinstance(existing_data, dict) and "items" in existing_data:
                catalog["items"] = existing_data["items"]
            elif isinstance(existing_data, list):
                catalog["items"] = existing_data
            print(f"[INFO] Successfully loaded existing catalog ({len(catalog['items'])} items).")
        else:
            print(f"[INFO] catalog_index.json not found on Archive.org (HTTP {res.status_code}). Initializing new catalog.")
    except Exception as e:
        print(f"[WARNING] Could not fetch catalog_index.json ({e}). Starting fresh.")

    # Remove duplicates matching ID or filename
    catalog["items"] = [
        item for item in catalog["items"] 
        if item.get("id") != new_entry["id"] and item.get("filename") != new_entry["filename"]
    ]

    # Prepend new entry so newest videos appear first
    catalog["items"].insert(0, new_entry)
    catalog["updated_at"] = datetime.now(timezone.utc).isoformat()

    local_catalog_path = "catalog_index.json"
    with open(local_catalog_path, "w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)

    print(f"[INFO] Re-uploading updated catalog_index.json ({len(catalog['items'])} total items)...")
    ia.upload(
        ia_item_id,
        files={ "catalog_index.json": local_catalog_path },
        access_key=access_key,
        secret_key=secret_key,
        headers={"x-archive-no-derive": "1"},
        queue_derive=False,
        retries=5,
        verbose=True
    )
    print("[SUCCESS] catalog_index.json synchronized on Internet Archive.")

    # Notify Cloudflare Worker to update KV immediately
    worker_url = os.environ.get("WORKER_URL", "https://nuvio-media-server.deepanshmahawar0.workers.dev")
    admin_pin = os.environ.get("ADMIN_PIN")
    if worker_url and admin_pin:
        try:
            print(f"[INFO] Notifying Cloudflare Worker KV ({worker_url}/api/catalog/append)...")
            append_res = requests.post(
                f"{worker_url}/api/catalog/append",
                json={"entry": new_entry, "admin_pin": admin_pin},
                timeout=10
            )
            if append_res.status_code == 200:
                print("[SUCCESS] Cloudflare KV catalog updated instantly!")
            else:
                print(f"[WARNING] Worker KV notify returned HTTP {append_res.status_code}")
        except Exception as e:
            print(f"[WARNING] Could not notify Cloudflare Worker KV: {e}")


def main():
    args = parse_args()

    # Validate required parameters
    if not args.video_url:
        print("[ERROR] Missing required video URL. Pass via --video-url or env VIDEO_URL.")
        sys.exit(1)

    ia_access_key = os.environ.get("IA_ACCESS_KEY")
    ia_secret_key = os.environ.get("IA_SECRET_KEY")

    if not ia_access_key or not ia_secret_key:
        print("[ERROR] Missing Archive.org S3 credentials. Ensure IA_ACCESS_KEY and IA_SECRET_KEY are set.")
        sys.exit(1)

    ia_item_id = args.ia_item_id.strip()
    print(f"=== Starting Ingestion into Archive.org Item: {ia_item_id} ===")
    print(f"Source URL: {args.video_url}")

    temp_dir = os.path.abspath(args.temp_dir)
    try:
        # Step 1: Download video and extract metadata
        print("\n--- Step 1: Downloading video & extracting metadata ---")
        video_file, info_data, thumb_file = download_video(args.video_url, temp_dir)

        raw_title = info_data.get("title") or "Vault Video"
        # Check if remote Content-Disposition provided a richer title for direct file links
        remote_title = detect_remote_title(args.video_url) if not args.custom_title else None
        title = (args.custom_title or remote_title or raw_title).strip()
        duration = info_data.get("duration") or 0
        description = (info_data.get("description") or f"Uploaded to {ia_item_id}").strip()
        resolution = f"{info_data.get('width', '')}x{info_data.get('height', '')}" if info_data.get('width') else (info_data.get('resolution') or "HD")
        file_size = os.path.getsize(video_file)
        size_mb = round(file_size / (1024 * 1024), 2)

        # Step 2: Sanitize filename
        print("\n--- Step 2: Sanitizing filename ---")
        clean_filename, short_hash = sanitize_filename(title, video_file)
        target_video_path = os.path.join(temp_dir, clean_filename)
        os.rename(video_file, target_video_path)
        print(f"[INFO] Sanitized video filename: {clean_filename} ({size_mb} MB)")

        # Step 3: Determine ID and Poster URL
        if args.imdb_id and args.imdb_id.strip():
            item_id = args.imdb_id.strip()
        else:
            item_id = f"ia_{short_hash}"

        poster_url = args.poster_url
        files_to_upload = { clean_filename: target_video_path }

        # If no poster provided and no yt-dlp thumb, extract video frame via ffmpeg
        if not poster_url and not thumb_file and shutil.which("ffmpeg"):
            print("[INFO] No external poster found. Automatically extracting high-quality frame using ffmpeg...")
            extracted_thumb = os.path.join(temp_dir, f"{clean_filename}_thumb.jpg")
            seek_time = "00:00:05" if duration and duration > 10 else "00:00:01"
            ffmpeg_cmd = [
                "ffmpeg", "-y", "-ss", seek_time,
                "-i", target_video_path,
                "-vframes", "1",
                "-q:v", "2",
                extracted_thumb
            ]
            try:
                subprocess.run(ffmpeg_cmd, capture_output=True, check=True)
                if os.path.isfile(extracted_thumb) and os.path.getsize(extracted_thumb) > 0:
                    thumb_file = extracted_thumb
                    print(f"[SUCCESS] Extracted automatic video thumbnail frame: {extracted_thumb}")
            except Exception as e:
                print(f"[WARNING] Automatic ffmpeg frame extraction failed: {e}")

        # Upload local thumbnail to Archive.org so it is permanently hosted
        if not poster_url and thumb_file and os.path.isfile(thumb_file):
            _, thumb_ext = os.path.splitext(thumb_file)
            if not thumb_ext:
                thumb_ext = ".jpg"
            thumb_name = f"{clean_filename}_thumb{thumb_ext}"
            thumb_target = os.path.join(temp_dir, thumb_name)
            if thumb_file != thumb_target:
                os.rename(thumb_file, thumb_target)
            files_to_upload[thumb_name] = thumb_target
            poster_url = f"https://archive.org/download/{ia_item_id}/{urllib.parse.quote(thumb_name)}"
            print(f"[INFO] Using self-hosted Archive.org thumbnail: {poster_url}")
        elif not poster_url and args.imdb_id and args.imdb_id.strip().startswith("tt"):
            # Use Cinemeta / IMDb poster provider if IMDb ID is supplied
            poster_url = f"https://images.metahub.space/poster/medium/{args.imdb_id.strip()}/img"
            print(f"[INFO] Using official Cinemeta/IMDb poster: {poster_url}")
        elif not poster_url:
            poster_url = f"https://archive.org/services/img/{ia_item_id}"
            print(f"[INFO] Fallback to Archive.org vault poster: {poster_url}")

        # Step 4: Upload to Internet Archive with --no-derive
        print(f"\n--- Step 3: Uploading to Internet Archive item '{ia_item_id}' ---")
        metadata = {
            "mediatype": "movies",
            "collection": "opensource_movies",
            "title": f"Nuvio Cloud Vault - {ia_item_id}",
            "description": "Zero-Cost Automated Video Vault powered by Internet Archive & Cloudflare Workers."
        }

        print(f"[INFO] Uploading files: {list(files_to_upload.keys())}")
        ia.upload(
            ia_item_id,
            files=files_to_upload,
            metadata=metadata,
            access_key=ia_access_key,
            secret_key=ia_secret_key,
            headers={"x-archive-no-derive": "1"},
            queue_derive=False,
            retries=5,
            verbose=True
        )
        print("[SUCCESS] Video successfully uploaded to Archive.org!")

        # Step 5: Update catalog_index.json
        print("\n--- Step 4: Syncing catalog_index.json ---")
        direct_stream_url = f"https://archive.org/download/{ia_item_id}/{urllib.parse.quote(clean_filename)}"
        new_entry = {
            "id": item_id,
            "imdb_id": args.imdb_id.strip() if args.imdb_id else None,
            "title": title,
            "filename": clean_filename,
            "direct_stream_url": direct_stream_url,
            "poster": poster_url,
            "description": description[:1000],
            "duration": duration,
            "duration_str": format_duration(duration),
            "size_bytes": file_size,
            "size_mb": size_mb,
            "resolution": resolution,
            "added_at": datetime.now(timezone.utc).isoformat()
        }

        sync_catalog_index(ia_item_id, ia_access_key, ia_secret_key, new_entry)

        print("\n==================================================")
        print("🎉 INGESTION COMPLETE!")
        print(f"🎬 Title:      {title}")
        print(f"🆔 ID:         {item_id}")
        print(f"📁 File:       {clean_filename}")
        print(f"⚡ Stream URL: {direct_stream_url}")
        print(f"🖼️ Poster:     {poster_url}")
        print(f"📦 Archive:    https://archive.org/details/{ia_item_id}")
        print("==================================================")

    finally:
        # Cleanup temporary files
        if os.path.exists(temp_dir):
            print(f"[INFO] Cleaning up temporary directory: {temp_dir}")
            shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
