# Gerrit UI for GitLab (Chrome Extension)

Transforms GitLab Merge Request pages (on `gitlab.com` or any self-hosted GitLab server) into a PolyGerrit-style code review interface.

## Installation
1. Unzip this archive to a permanent folder.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the unzipped `gerrit-ui-for-gitlab` folder.
5. Open any GitLab Merge Request — Gerrit View activates automatically (press `Shift + G` or click **GitLab View** anytime to switch back).

## Keyboard Shortcuts
- `a` — Open Reply dialog (vote + batch-publish drafts)
- `j` / `k` — Next / Previous file in Change view
- `Enter` / `o` — Open selected file diff
- `u` — Return to Change view from Diff view
- `[` / `]` — Previous / Next file in Diff view
- `n` / `p` — Next / Previous diff chunk
- `c` — Add inline draft comment on clicked line
- `r` — Mark file as Reviewed
- `Shift + G` — Toggle Gerrit View / GitLab View
- `?` — Shortcuts cheat sheet
