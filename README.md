# pi-inlineskill

Use installed Pi skills anywhere in a prompt with `/name` or `/skill:name`:

```text
Please use /a and then /skill:b.
```

Type `/` at the start of a line or after whitespace to open completion. Use the arrow keys to choose, Tab to insert, or Enter to select and submit. Tab also completes partial references.

Before submission, the extension replaces the references with `skill:a` and `skill:b` and appends each skill's instructions. Each skill appears once, in first-use order, without YAML frontmatter. Supporting files remain available relative to the skill directory.

## Install

```sh
pi install npm:@moritzwilksch/pi-inlineskill
```

From a local checkout, use `pi install .`, or try it for one session with `pi -e ./index.ts`.

## Behavior

- Unknown names, paths, URLs, escaped slashes, and references in code stay unchanged. Skill content is not expanded recursively.
- Leading prompt commands keep their native meaning when a skill shares their name.
- Images are preserved. Expansion works with interactive, RPC, and extension-injected input.
- Unreadable skills cancel submission and report the file error.
- Pi handles skill discovery and reload. This extension replaces the editor, so don't combine it with another extension that replaces the editor.

## Development

```sh
npm install --ignore-scripts
npm test
npm run check
```
