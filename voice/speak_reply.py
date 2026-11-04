#!/usr/bin/env python3
"""Speak text with edge-tts (a free Microsoft neural voice) and upload the mp3 to Slack.

Configurable via flags or environment:
  EDGE_TTS_VOICE   default en-US-AriaNeural
  EDGE_TTS_RATE    default +0%     (edge-tts rate string, e.g. -10% or +20%)
  EDGE_TTS_PITCH   default +0Hz    (edge-tts pitch string, e.g. +2Hz)

The Slack file title comes from --topic, otherwise from the first sentence of
the text. --thread-ts is optional. --comment becomes the file's initial_comment.

files.completeUploadExternal cannot set reply_broadcast. Pass --broadcast to
also post a short chat.postMessage in that thread with reply_broadcast set.
Skip --broadcast in DMs; a top-level upload is the whole reply.

Examples:
  python speak_reply.py --text-file reply.txt --channel <channel-id> --topic "status"
  python speak_reply.py --text-file reply.txt --channel <channel-id> --thread-ts <thread-ts> --broadcast
  python speak_reply.py --text "On it." --out reply.mp3
"""

import argparse
import asyncio
import os
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from slackcommon import SlackError, post_message, upload_file

DEFAULT_VOICE = "en-US-AriaNeural"
DEFAULT_RATE = "+0%"
DEFAULT_PITCH = "+0Hz"


def title_from_topic(topic, text):
    """Short Slack file title. Prefer an explicit topic, else the first sentence."""
    raw = " ".join((topic or "").split())
    if not raw:
        collapsed = " ".join((text or "").split())
        raw = re.split(r"(?<=[.!?])\s", collapsed, maxsplit=1)[0] if collapsed else ""
    if len(raw) > 80:
        raw = raw[:77].rstrip() + "..."
    return raw or "Voice reply"


def mp3_filename(title):
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", title).strip("-").lower()
    if not slug:
        slug = "voice-reply"
    return slug[:60] + ".mp3"


def read_text(args):
    if args.text and args.text_file:
        raise SystemExit("pass only one of --text or --text-file")
    if args.text_file:
        if args.text_file == "-":
            return sys.stdin.read()
        return Path(args.text_file).read_text(encoding="utf-8")
    if args.text:
        return args.text
    if not sys.stdin.isatty():
        return sys.stdin.read()
    raise SystemExit("pass --text, --text-file, or pipe the reply on stdin")


async def synthesize(text, path, *, voice, rate, pitch):
    try:
        import edge_tts
    except ImportError as err:
        raise SystemExit("edge-tts is not installed. From voice/: pip install -r requirements.txt") from err
    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
    await communicate.save(str(path))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Speak a reply with edge-tts and upload it to Slack")
    parser.add_argument("--text", help="Reply text. Mutually exclusive with --text-file.")
    parser.add_argument("--text-file", help="UTF-8 text file to speak. Use - for stdin.")
    parser.add_argument("--channel", help="Slack channel id to share the file into. Omit to only write the mp3.")
    parser.add_argument("--thread-ts", help="Optional thread timestamp. Omit for a top-level share.")
    parser.add_argument("--topic", help="Clip topic used as the file title. Default: first sentence of the text.")
    parser.add_argument("--title", help="Exact file title. Overrides --topic.")
    parser.add_argument("--comment", default="", help="initial_comment on the uploaded file.")
    parser.add_argument("--voice", default=os.environ.get("EDGE_TTS_VOICE", DEFAULT_VOICE))
    parser.add_argument("--rate", default=os.environ.get("EDGE_TTS_RATE", DEFAULT_RATE))
    parser.add_argument("--pitch", default=os.environ.get("EDGE_TTS_PITCH", DEFAULT_PITCH))
    parser.add_argument("--out", help="Also keep the mp3 at this path.")
    parser.add_argument(
        "--broadcast",
        action="store_true",
        help="After upload, post a separate thread message with reply_broadcast. Uploads cannot set that flag.",
    )
    parser.add_argument(
        "--broadcast-text",
        help="Text of the broadcast message. Default: --comment, or 'Voice reply: <title>'.",
    )
    args = parser.parse_args(argv)

    text = read_text(args).strip()
    if not text:
        raise SystemExit("nothing to speak")
    title = args.title.strip() if args.title else title_from_topic(args.topic, text)
    filename = mp3_filename(title)

    fd, tmp = tempfile.mkstemp(prefix="slack-voice-", suffix=".mp3")
    os.close(fd)
    tmp_path = Path(tmp)
    try:
        asyncio.run(synthesize(text, tmp_path, voice=args.voice, rate=args.rate, pitch=args.pitch))
        if args.out:
            Path(args.out).write_bytes(tmp_path.read_bytes())
        if not args.channel:
            if not args.out:
                print("pass --channel to upload, or --out to keep the mp3", file=sys.stderr)
                return 1
            print(args.out)
            return 0
        result = upload_file(
            tmp_path,
            channel=args.channel,
            filename=filename,
            title=title,
            thread_ts=args.thread_ts or None,
            comment=args.comment or None,
        )
        print(result["file_id"])
        if args.broadcast:
            if not args.thread_ts:
                print("reply_broadcast only applies to a channel thread; upload is top-level, no extra message", file=sys.stderr)
            else:
                notice = args.broadcast_text or args.comment or f"Voice reply: {title}"
                post_message(args.channel, notice, thread_ts=args.thread_ts, reply_broadcast=True)
    except SlackError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
