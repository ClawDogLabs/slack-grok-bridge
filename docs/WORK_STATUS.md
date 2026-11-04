# Work status file

Slack answers about "what are you working on?" have to match the main agent chat. The main agent is the source of truth. The Slack routine only reads.

## File

Live path, next to the bridge checkout:

```text
state/active-work.md
```

That path is gitignored. Copy [`../state/active-work.example.md`](../state/active-work.example.md) to `state/active-work.md` once, then let the main agent edit the live file.

## Who writes it

The **main agent** updates `state/active-work.md` when work starts, changes, finishes, or blocks. A one-line "Last updated" timestamp is enough for the Slack side to see freshness. Do not put secrets, tokens, or webhook URLs in the file.

## Who reads it

The **Slack routine** reads `state/active-work.md` before it answers any status question (what are you doing, how's X going, are you stuck, what shipped). Reply from the file. If the file is missing or still the untouched example, say you don't have a current status yet. Do not invent tasks to fill the gap.

Status questions still go through the [allowlist](../OWNER_SHARE_POLICY.example.md) and the [threading rule](../README.md#threading). Reading the file is not permission to post it in a public channel.
