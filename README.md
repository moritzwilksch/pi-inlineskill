# pi-inlineskill

Trigger installed Pi skills anywhere in a prompt with `/name` or `/skill:name`. Typing `/` after whitespace or at the start of a line invokes Pi's completion action. Keep typing to filter, use arrow keys to choose, and Tab to insert. Enter selects and submits, as with native slash commands. Tab also completes partial references directly.

A small `CustomEditor` subclass opens completion; Pi owns the menu, filtering updates, key handling, and insertion. Normal input delegates to Pi. Like native Tab completion, a single match inserts immediately. This extension replaces other custom editors; do not combine it with an extension that also replaces the editor.

```text
Please use /a and then /skill:b.
```

The extension replaces these references with `skill:a` and `skill:b`, then appends each skill's full body in Pi's native `<skill name="…" location="…">` format. YAML frontmatter is omitted, as in Pi. Skill directories remain in the blocks so supporting files resolve correctly.

Skill files are read by the extension before submission. The agent receives the instructions directly; it needs no `read()` call to load them. Blocks appear once per skill, in first-use order. Expansion does not recurse into skill content.

## Install

From npm:

```sh
pi install npm:@moritzwilksch/pi-inlineskill
```

From this directory:

```sh
pi install .
```

Or try it for one session:

```sh
pi -e ./index.ts
```

## Behavior

- Both forms work at the beginning, middle, or end of a prompt.
- Unknown names, paths, URLs, escaped slashes, inline code, and fenced code stay unchanged.
- Leading prompt commands keep their native meaning if a skill shares their name. Pi dispatches extension and built-in commands normally.
- Images are preserved. Interactive, RPC, and extension-injected input use the same expansion.
- Unreadable skills cancel submission and report the file error. No partial or path-only expansion is sent.
- Pi owns skill discovery and reload. No configuration or runtime dependencies are added.

## Development

```sh
npm install --ignore-scripts
npm test
npm run check
```
