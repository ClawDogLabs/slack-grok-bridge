# Voice in / out

Local helpers for a Slack routine that hears an audio clip and answers with a spoken file. No paid TTS account: transcription is [faster-whisper](https://github.com/SYSTRAN/faster-whisper) on the machine that runs the script, and speech is [edge-tts](https://github.com/rany2/edge-tts) (Microsoft Edge's online neural voices, no API key).

| Script | Role |
| --- | --- |
| `transcribe.py` | Download a Slack audio file and print a local transcript |
| `speak_reply.py` | Turn reply text into an mp3 and upload it |
| `slackcommon.py` | Shared Slack calls (download, external upload, optional `chat.postMessage`) |

## Setup

```bash
python3 -m pip install -r voice/requirements.txt
```

Run the scripts from the bridge checkout (`python3 voice/transcribe.py …`) or from `voice/`.

`ffmpeg` has to be on `PATH`. faster-whisper uses it to decode the formats Slack actually sends (`m4a`, `mp3`, `webm`, `wav`, `ogg`). It is a system package, not a pip dependency.

The Slack app needs **`files:read`** (download / `files.info`) and **`files:write`** (upload). Add them, reinstall the app, and refresh `SLACK_BOT_TOKEN`. A broadcast note also needs `chat:write`, which the bridge already uses.

`SLACK_BOT_TOKEN` is read from the environment. Do not pass it as an argument and do not print it.

## Transcribe

```bash
export SLACK_BOT_TOKEN=...   # bot token from your secret store, never from chat
python3 transcribe.py --file-id <file-id>
python3 transcribe.py --file-id <file-id> --out /tmp/transcript.txt
python3 transcribe.py --path clip.m4a
```

Stdout is only the transcript. A one-line note on stderr records the model, detected language, mimetype, and file id.

| Input | Default | Meaning |
| --- | --- | --- |
| `--model` / `WHISPER_MODEL` | `base` | faster-whisper model size (`tiny`, `base`, `small`, `medium`, …) |
| `--language` / `WHISPER_LANGUAGE` | auto | Language code, e.g. `en` |
| `--device` / `WHISPER_DEVICE` | `cpu` | `cpu`, `cuda`, or `auto` |
| `--keep PATH` | | Also save the downloaded audio |

## Speak and upload

```bash
python3 speak_reply.py --text-file reply.txt --channel <channel-id> --topic "weekly status"
python3 speak_reply.py --text-file reply.txt --channel <channel-id> \
  --thread-ts <thread-ts> --comment "voice reply" --broadcast
python3 speak_reply.py --text "On it." --out /tmp/reply.mp3
```

| Input | Default | Meaning |
| --- | --- | --- |
| `--text` / `--text-file` | stdin if piped | Text to speak. `--text-file -` is stdin. |
| `--voice` / `EDGE_TTS_VOICE` | `en-US-AriaNeural` | edge-tts voice name. List them with `edge-tts --list-voices`. |
| `--rate` / `EDGE_TTS_RATE` | `+0%` | Speed, e.g. `-10%` or `+20%` |
| `--pitch` / `EDGE_TTS_PITCH` | `+0Hz` | Pitch, e.g. `+2Hz` |
| `--topic` | first sentence of the text | Clip topic. The file **title** is this topic, clipped to 80 characters. |
| `--title` | | Exact title. Overrides `--topic`. |
| `--comment` | none | `initial_comment` on the Slack file |
| `--thread-ts` | none | Share into this thread. Omit for a top-level DM or channel message. |
| `--channel` | none | Slack channel id from the webhook. Omit, with `--out`, to render an mp3 and not upload. |
| `--broadcast` | off | Also post a short channel-visible note. See below. |
| `--broadcast-text` | comment, or `Voice reply: <title>` | Body of that note |

The filename is a slug of the title plus `.mp3`.

### Uploads cannot `reply_broadcast`

`files.getUploadURLExternal` + `files.completeUploadExternal` share a file into a channel and, if you pass it, a thread. They have no `reply_broadcast` parameter, so a thread upload stays in the thread.

When the [threading rule](../README.md#threading) says a channel reply should also show in the channel, pass `--broadcast`. The script uploads the audio (with `--thread-ts` when there is one) and then posts a **separate** `chat.postMessage` in that thread with `reply_broadcast: true`. The note is the comment, or `Voice reply: <title>`, unless you set `--broadcast-text`. It does not paste the whole script into the channel.

In a DM, leave `--broadcast` off and omit `--thread-ts` unless the inbound message was already in a thread. `reply_broadcast` is a channel-thread flag; the script skips the extra message when there is no `--thread-ts`.

## What the routine should do

1. If the webhook `slack.files` entry is audio (`mimetype` starts with `audio/`, or a voice clip), run `transcribe.py --file-id <id>` and treat the stdout as the user's words.
2. Log the file id and mimetype with the rest of the message. See [../docs/MESSAGE_LOG.md](../docs/MESSAGE_LOG.md). Do not log `url_private` or the bot token.
3. If a spoken reply is appropriate, write the reply text to a temp file and run `speak_reply.py` with `--topic` set from what the clip was about, `--channel` from the event, and `--thread-ts` only when `reply.thread_ts` in the webhook payload is set.
4. For a channel, add `--broadcast` so the channel sees a one-line note. The audio itself is the thread reply.
