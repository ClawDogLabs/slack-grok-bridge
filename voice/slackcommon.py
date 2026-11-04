"""Small Slack Web API helpers for the voice scripts.

Token: environment variable SLACK_BOT_TOKEN (xoxb-...). Never print it.
Scopes: files:read to download a clip, files:write to upload a reply,
chat:write only if you also post a broadcast message.

Uploads go through files.getUploadURLExternal + files.completeUploadExternal.
That pair cannot set reply_broadcast. Post a separate chat.postMessage when
a channel thread should also appear in the channel.
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request

API = "https://slack.com/api/"


class SlackError(RuntimeError):
    pass


def token():
    value = os.environ.get("SLACK_BOT_TOKEN", "").strip()
    if not value:
        raise SlackError("SLACK_BOT_TOKEN is not set")
    return value


def api(method, payload=None, *, query=None):
    """Call a Slack Web API method. GET when query is set, otherwise POST JSON."""
    tok = token()
    if query is not None:
        qs = urllib.parse.urlencode(query)
        url = f"{API}{method}?{qs}" if qs else f"{API}{method}"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"})
    else:
        data = json.dumps(payload or {}).encode()
        req = urllib.request.Request(
            f"{API}{method}",
            data=data,
            method="POST",
            headers={
                "Authorization": f"Bearer {tok}",
                "Content-Type": "application/json; charset=utf-8",
            },
        )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read().decode())
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")[:300]
        raise SlackError(f"{method} http {err.code}: {detail}") from None
    except urllib.error.URLError as err:
        raise SlackError(f"{method} request failed: {err.reason}") from None
    if not body.get("ok"):
        raise SlackError(f"{method} failed: {body.get('error', 'unknown')}")
    return body


def file_info(file_id):
    return api("files.info", query={"file": file_id})["file"]


class _KeepAuthRedirects(urllib.request.HTTPRedirectHandler):
    """Slack file URLs redirect to the file host. Keep the bot token across that hop."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        auth = req.get_header("Authorization")
        if new is not None and auth:
            new.add_unredirected_header("Authorization", auth)
        return new


def download_file(file_id, dest):
    """Download a Slack file to dest. Returns the files.info object.

    Needs files:read. The private URL is not printed.
    """
    info = file_info(file_id)
    url = info.get("url_private_download") or info.get("url_private")
    if not url:
        raise SlackError("file has no private URL; the bot needs files:read and access to the file")
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token()}"})
    opener = urllib.request.build_opener(_KeepAuthRedirects)
    try:
        with opener.open(req, timeout=120) as resp, open(dest, "wb") as out:
            out.write(resp.read())
    except urllib.error.HTTPError as err:
        raise SlackError(f"download http {err.code} for file {file_id}") from None
    except urllib.error.URLError as err:
        raise SlackError(f"download failed for file {file_id}: {err.reason}") from None
    return info


def upload_file(path, *, channel=None, filename=None, title=None, thread_ts=None, comment=None):
    """Upload a local file. channel is optional (omit to upload without sharing).

    completeUploadExternal accepts thread_ts. It does not accept reply_broadcast.
    """
    filename = filename or os.path.basename(path)
    size = os.path.getsize(path)
    got = api(
        "files.getUploadURLExternal",
        query={"filename": filename, "length": str(size)},
    )
    upload_url = got.get("upload_url")
    file_id = got.get("file_id")
    if not upload_url or not file_id:
        raise SlackError("files.getUploadURLExternal returned no upload_url or file_id")
    with open(path, "rb") as fh:
        data = fh.read()
    req = urllib.request.Request(
        upload_url,
        data=data,
        method="POST",
        headers={"Content-Type": "application/octet-stream", "Content-Length": str(len(data))},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            status = resp.status
            resp.read()
    except urllib.error.HTTPError as err:
        raise SlackError(f"upload http {err.code}") from None
    except urllib.error.URLError as err:
        raise SlackError(f"upload failed: {err.reason}") from None
    if status >= 400:
        raise SlackError(f"upload http {status}")
    payload = {"files": [{"id": file_id, "title": title or filename}]}
    if channel:
        payload["channel_id"] = channel
    if thread_ts:
        payload["thread_ts"] = thread_ts
    if comment:
        payload["initial_comment"] = comment
    completed = api("files.completeUploadExternal", payload)
    return {"file_id": file_id, "completed": completed}


def post_message(channel, text, *, thread_ts=None, reply_broadcast=False):
    payload = {"channel": channel, "text": text}
    if thread_ts:
        payload["thread_ts"] = thread_ts
    if reply_broadcast:
        payload["reply_broadcast"] = True
    return api("chat.postMessage", payload)
