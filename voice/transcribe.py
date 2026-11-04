#!/usr/bin/env python3
"""Transcribe a Slack audio clip locally with faster-whisper.

ffmpeg must be on PATH. The script downloads the file with files:read
(or reads a local path) and prints the transcript on stdout.

Examples:
  python transcribe.py --file-id <file-id>
  python transcribe.py --path clip.m4a --out transcript.txt
  WHISPER_MODEL=small python transcribe.py --file-id <file-id> --language en
"""

import argparse
import os
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from slackcommon import SlackError, download_file

MIME_SUFFIX = {
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/webm": ".webm",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/ogg": ".ogg",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
}


def suffix_for(info):
    name = str(info.get("name") or "")
    if "." in name:
        ext = name.rsplit(".", 1)[-1].lower()
        if re.fullmatch(r"[a-z0-9]{1,5}", ext):
            return "." + ext
    return MIME_SUFFIX.get(str(info.get("mimetype") or ""), ".audio")


def transcribe(path, *, model_name, language, device):
    try:
        from faster_whisper import WhisperModel
    except ImportError as err:
        raise SystemExit(
            "faster-whisper is not installed. From voice/: pip install -r requirements.txt"
        ) from err
    compute = "int8" if device == "cpu" else "float16"
    model = WhisperModel(model_name, device=device, compute_type=compute)
    segments, info = model.transcribe(str(path), language=language or None)
    text = "".join(segment.text for segment in segments).strip()
    return text, getattr(info, "language", None)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Transcribe a Slack audio file locally")
    parser.add_argument("--file-id", help="Slack file id (needs SLACK_BOT_TOKEN and files:read)")
    parser.add_argument("--path", help="Local audio path instead of a Slack file id")
    parser.add_argument("--out", help="Also write the transcript to this path")
    parser.add_argument("--model", default=os.environ.get("WHISPER_MODEL", "base"))
    parser.add_argument("--language", default=os.environ.get("WHISPER_LANGUAGE") or None)
    parser.add_argument("--device", default=os.environ.get("WHISPER_DEVICE", "cpu"), choices=["cpu", "cuda", "auto"])
    parser.add_argument("--keep", help="When using --file-id, also save the downloaded audio here")
    args = parser.parse_args(argv)
    if bool(args.file_id) == bool(args.path):
        parser.error("pass exactly one of --file-id or --path")

    temp_path = None
    mimetype = None
    try:
        if args.path:
            audio = args.path
        else:
            fd, downloaded = tempfile.mkstemp(prefix="slack-audio-")
            os.close(fd)
            temp_path = downloaded
            info = download_file(args.file_id, downloaded)
            mimetype = info.get("mimetype")
            audio = downloaded + suffix_for(info)
            os.replace(downloaded, audio)
            temp_path = audio
            if args.keep:
                Path(args.keep).write_bytes(Path(audio).read_bytes())
        text, language = transcribe(audio, model_name=args.model, language=args.language, device=args.device)
    except SlackError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass

    if args.out:
        Path(args.out).write_text(text + ("\n" if text else ""), encoding="utf-8")
    print(text)
    meta = f"model={args.model}"
    if language:
        meta += f" language={language}"
    if mimetype:
        meta += f" mimetype={mimetype}"
    if args.file_id:
        meta += f" file_id={args.file_id}"
    print(meta, file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
