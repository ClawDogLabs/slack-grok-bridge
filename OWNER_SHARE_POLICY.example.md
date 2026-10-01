# Owner share policy (example)

Copy to `OWNER_SHARE_POLICY.md` beside your live bridge (or keep only in Grok memory).
**Each owner has their own list.** Default: deny.

## Allow without new approval

List topics the owner explicitly said the bot may answer publicly without waiting:

1. Example: Child extracurricular **names only**: Piano, Gymnastics, Sewing, Dance (no times, locations, or teachers).
2. Example: Public bot/role/setup facts about what the bot does.

## Always hold (ask the owner first)

- Schedules, times, locations, teachers
- Family calendar detail
- Home address
- Mail / packages
- Medical / money
- School logistics
- Anything not listed under Allow

## How the owner manages the list

In chat with their Grok Bot, say things like:

- "Add X to the share allowlist (bounds: …)"
- "Remove X from the allowlist"
- "Don't share X anymore"
- "You can answer Y without asking me first"

The bot should update durable memory **and** this file (if present), then confirm the new list.

One-off approvals ("post that") do **not** auto-add. The bot should ask once: "Add this to the allowlist for next time?" and only add on yes.
