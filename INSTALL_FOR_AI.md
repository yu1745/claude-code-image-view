# Installing image-view (instructions for AI agents)

You are an AI coding agent (e.g. Claude Code) asked to install the `image-view` mod for the user.
Follow the steps in order. Do not skip the verification step. Do not edit files outside the paths named here.

## What it is

A Claude Code mod (hooks module, no build step) that renders images inline in the terminal:
expandable `Read` results for image files and `![alt](/abs/path)` in assistant replies.
Source: `https://github.com/yu1745/claude-code-image-view` — plugin name `image-view`.

## 0. Preconditions — check, don't assume

Run these and read the output:

```bash
command -v identify convert   # ImageMagick; both must be found
echo "$TERM $TERM_PROGRAM $KITTY_WINDOW_ID"   # hint only
claude --version
```

- Claude Code must be **>= 2.1.287** (first version with Claude Mods; verified on 2.1.296). If `claude --version`
  is older, tell the user to upgrade first and stop.
- If `identify` or `convert` is missing, tell the user and ask before installing ImageMagick
  (`sudo apt install imagemagick` / `brew install imagemagick`). Installing system packages needs their approval.
- The terminal must support the kitty graphics protocol (kitty, Ghostty, ...). You cannot reliably detect this;
  if the user is on another terminal, say that images will fall back to alt text and continue only if they accept.

## 1. Install

`/plugin install ...` is a slash command typed at the prompt of an interactive Claude Code terminal session.
You cannot run it through Bash. Do this instead:

**Option A — ask the user to type this at the Claude Code prompt (recommended, persistent):**

```
/plugin install image-view --marketplace yu1745/claude-code-image-view
```

Tell them: answer `y` to `Add marketplace?`, then pick the **user** scope with Enter.
Expected result: `Installed image-view. Plugin is now active.` No restart needed.

**Option B — load from disk for one session (no slash command needed):**

```bash
git clone https://github.com/yu1745/claude-code-image-view.git ~/.claude/dev-plugins/image-view
claude --plugin-dir ~/.claude/dev-plugins/image-view
```

or, to load it in every session, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of
`~/.claude/settings.json` (absolute path; never in a project's settings). Show the user the exact edit
and get confirmation before changing their settings file.

## 2. Validate (Option B, or if you cloned the repo)

```bash
claude plugin validate ~/.claude/dev-plugins/image-view
```

It must report no errors for the manifest, marketplace file and hooks module.

## 3. Verify it works

1. Create a test image in a scratch directory (not in the user's project):
   ```bash
   convert -size 640x360 gradient:'#ff6b6b-#4ecdc4' /tmp/image-view-test.png
   ```
2. `Read` that file. The tool result should be followed by a `[ 展开图片 ]` button (expand image).
3. In your reply include `![test](/tmp/image-view-test.png)`. The image should render under the message,
   with `放大` / `缩小` buttons and an `N×M 格` size label.
4. Delete the test file when done.

If the button does not appear: run the session with `claude --debug` and look for lines beginning with
`image-view:` or `ui.render (...)`: a hook returned a tree that does not validate`. Report the line to the user
verbatim rather than guessing.

## 4. Report back

Tell the user: which option you used, whether `identify`/`convert` were present, the validation result, and what you
saw in step 3 (button present? image rendered or alt text only?). If any step failed or was skipped, say so first.

## Notes for the agent

- The mod only reads local files and writes converted PNGs to `/tmp/cc-image-view`. It makes no network calls.
- Uninstall: `/plugin uninstall image-view` (user types it), or remove the folder / env entry from Option B.
- Tunable constants (`MAX_COLUMNS`, `MAX_ROWS`, `MIN_ROWS`, `ROWS_DIVISOR`, `SCALE_STEP`) are at the top of
  `hooks/register.tsx`; change them only if the user asks.
