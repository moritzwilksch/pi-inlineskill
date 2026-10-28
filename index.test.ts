import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type {
  AutocompleteProviderFactory,
  CustomEditor,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  KeybindingsManager,
  SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, Editor, getKeybindings, type TUI } from "@earendil-works/pi-tui";
import inlineSkills from "./index.ts";

const identity = (text: string) => text;
const theme = {
  borderColor: identity,
  selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-inlineskill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const commands: SlashCommandInfo[] = [];
  for (const name of ["a", "b", "spell-check"]) {
    const directory = join(root, name);
    await mkdir(directory);
    const path = join(directory, "SKILL.md");
    await writeFile(path, `---\nname: ${name}\ndescription: Test skill\n---\n\n# ${name}\n\nUse references/guide.md.\nKeep /b literal here.\n`);
    commands.push({ name: `skill:${name}`, source: "skill", sourceInfo: { path, source: "local", scope: "user", origin: "top-level" } });
  }
  type Handler = (event: InputEvent, ctx: ExtensionContext) => Promise<InputEventResult>;
  const handlers = new Map<string, Handler>();
  const notices: string[] = [];
  let wrap!: AutocompleteProviderFactory;
  let editorFactory!: NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;
  inlineSkills({
    on: (name: string, callback: Handler) => handlers.set(name, callback),
    getCommands: () => commands,
  } as unknown as ExtensionAPI);
  const ctx = {
    mode: "tui",
    ui: {
      notify: (message: string) => notices.push(message),
      addAutocompleteProvider: (factory: AutocompleteProviderFactory) => {
        wrap = factory;
      },
      setEditorComponent: (factory: typeof editorFactory) => {
        editorFactory = factory;
      },
    },
  } as unknown as ExtensionContext;
  await handlers.get("session_start")!({} as InputEvent, ctx);
  const native = new CombinedAutocompleteProvider([{ name: "help", description: "Native help" }], root);
  const provider = wrap(native);
  return {
    root,
    commands,
    notices,
    provider,
    native,
    editor: () => {
      const editor = editorFactory(
        { requestRender() {}, terminal: { rows: 40 } } as unknown as TUI,
        theme,
        getKeybindings() as KeybindingsManager,
      ) as CustomEditor;
      editor.setAutocompleteProvider(provider);
      return editor;
    },
    suggest: (lines: string[], cursorLine = lines.length - 1, cursorCol = lines[cursorLine].length) =>
      provider.getSuggestions(lines, cursorLine, cursorCol, { signal: new AbortController().signal }),
    submit: (text: string, source: InputEvent["source"] = "interactive", images?: InputEvent["images"]) =>
      handlers.get("input")!({ type: "input", text, source, images }, ctx),
    block: (name: string) =>
      `<skill name="${name}" location="${join(root, name, "SKILL.md")}">\nReferences are relative to ${join(root, name)}.\n\n# ${name}\n\nUse references/guide.md.\nKeep /b literal here.\n</skill>`,
  };
}

test("embeds complete native skill blocks once, in first-use order", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.submit("please use /b, /a and /skill:b; then /spell-check."), {
    action: "transform",
    text: `please use skill:b, skill:a and skill:b; then skill:spell-check.\n\n${f.block("b")}\n\n${f.block("a")}\n\n${f.block("spell-check")}`,
    images: undefined,
  });
});

for (const syntax of ["/a", "/skill:a"]) {
  test(`expands leading ${syntax} and keeps the request`, async t => {
    const f = await fixture(t);
    assert.deepEqual(await f.submit(`${syntax} do the work`), {
      action: "transform",
      text: `skill:a do the work\n\n${f.block("a")}`,
      images: undefined,
    });
  });
}

for (const text of [
  "No references; /unknown /a-long /skill:unknown.",
  "https://example.com/a /tmp/a ./a ../a dir/a /a/file /a.txt C:/a \\/a",
  "`/a` and ``/skill:b with ` inside``",
  "```text\n/a\n/skill:b\n```",
  "~~~text\n/a\n~~~~",
  "```text\n/a\n/skill:b",
]) {
  test(`leaves literal text unchanged: ${JSON.stringify(text)}`, async t => {
    const f = await fixture(t);
    assert.deepEqual(await f.submit(text), { action: "continue" });
  });
}

test("expands references around code but never inside it", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.submit("Use (/a), not `/b`.\n```\n/b\n```\nThen /skill:a!"), {
    action: "transform",
    text: `Use (skill:a), not \`/b\`.\n\`\`\`\n/b\n\`\`\`\nThen skill:a!\n\n${f.block("a")}`,
    images: undefined,
  });
});

for (const source of ["interactive", "rpc", "extension"] as const) {
  test(`preserves images for ${source} input`, async t => {
    const f = await fixture(t);
    const images: NonNullable<InputEvent["images"]> = [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }];
    assert.deepEqual(await f.submit("Use /a", source, images), {
      action: "transform",
      text: `Use skill:a\n\n${f.block("a")}`,
      images,
    });
  });
}

test("preserves a leading prompt command that shares a skill name", async t => {
  const f = await fixture(t);
  f.commands.push({ ...f.commands[0]!, name: "a", source: "prompt" });
  assert.deepEqual(await f.submit("/a some request"), { action: "continue" });
});

test("reads current skill content on every submission", async t => {
  const f = await fixture(t);
  await f.submit("/a");
  await writeFile(join(f.root, "a", "SKILL.md"), "Updated instructions.");
  assert.deepEqual(await f.submit("/a"), {
    action: "transform",
    text: `skill:a\n\n<skill name="a" location="${join(f.root, "a", "SKILL.md")}">\nReferences are relative to ${join(f.root, "a")}.\n\nUpdated instructions.\n</skill>`,
    images: undefined,
  });
});

test("cancels submission instead of sending a partial or path-only expansion", async t => {
  const f = await fixture(t);
  await rm(join(f.root, "b", "SKILL.md"));
  assert.deepEqual(await f.submit("Use /a and /b"), { action: "handled" });
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0]!, /Cannot load skill:b.*ENOENT/);
});

for (const prefix of ["/sp", "/skill:sp"]) {
  test(`completes ${prefix} inline and embeds the selected skill on submission`, async t => {
    const f = await fixture(t);
    const lines = ["Please use", `my ${prefix}`];
    const suggestions = await f.suggest(lines);
    assert.equal(suggestions?.prefix, prefix);
    assert.deepEqual(
      suggestions?.items.map(item => item.value),
      [prefix.startsWith("/skill:") ? "/skill:spell-check" : "/spell-check"],
    );
    const applied = f.provider.applyCompletion(lines, 1, lines[1].length, suggestions!.items[0], suggestions!.prefix);
    assert.deepEqual(applied, { lines: ["Please use", `my ${suggestions!.items[0].value}`], cursorLine: 1, cursorCol: 3 + suggestions!.items[0].value.length });
    assert.deepEqual(await f.submit(applied.lines.join("\n")), {
      action: "transform",
      text: `Please use\nmy skill:spell-check\n\n${f.block("spell-check")}`,
      images: undefined,
    });
  });
}

test("offers native commands alongside leading skill shortcuts", async t => {
  const f = await fixture(t);
  const suggestions = await f.suggest(["/"]);
  assert.deepEqual(
    suggestions?.items.map(item => item.value),
    ["help", "/a", "/b", "/spell-check"],
  );
  assert.deepEqual(f.provider.applyCompletion(["/"], 0, 1, suggestions!.items[0], "/"), {
    lines: ["/help "],
    cursorLine: 0,
    cursorCol: 6,
  });
});

test("completion preserves text and punctuation after the cursor", async t => {
  const f = await fixture(t);
  const lines = ["Use (/sp), then continue."];
  const suggestions = await f.suggest(lines, 0, 8);
  assert.deepEqual(f.provider.applyCompletion(lines, 0, 8, suggestions!.items[0], suggestions!.prefix), {
    lines: ["Use (/spell-check), then continue."],
    cursorLine: 0,
    cursorCol: 17,
  });
});

for (const [lines, cursorCol] of [
  [["Use `/sp`"], 8],
  [["```", "/sp", "```"], 3],
  [["Use ./sp"], 8],
  [["Use https://example.com/sp"], 26],
] as const) {
  test(`does not add skill suggestions in literal context: ${lines.join(" ")}`, async t => {
    const f = await fixture(t);
    const cursorLine = lines.length === 3 ? 1 : 0;
    const options = { signal: new AbortController().signal };
    assert.deepEqual(await f.suggest([...lines], cursorLine, cursorCol), await f.native.getSuggestions([...lines], cursorLine, cursorCol, options));
  });
}

test("preserves native forced file completion", async t => {
  const f = await fixture(t);
  const options = { signal: new AbortController().signal, force: true };
  assert.deepEqual(await f.provider.getSuggestions(["a/"], 0, 2, options), await f.native.getSuggestions(["a/"], 0, 2, options));
});

for (const text of ["Use /sp", "Use /skill:sp", "Use\n/sp"]) {
  test(`Tab completes a unique skill through Pi's real editor: ${JSON.stringify(text)}`, async t => {
    const f = await fixture(t);
    const editor = new Editor({ requestRender() {} } as unknown as TUI, theme);
    editor.setAutocompleteProvider(f.provider);
    editor.setText(text);
    editor.handleInput("\t");
    const expected = text.replace(/\/(?:skill:)?sp$/, match => (match.startsWith("/skill:") ? "/skill:spell-check" : "/spell-check"));
    await t.waitFor(() => assert.equal(editor.getText().trimEnd(), expected), { timeout: 1000, interval: 5 });
    assert.equal(editor.isShowingAutocomplete(), false);
  });
}

test("Tab uses Pi's menu and key handling for multiple inline skills", async t => {
  const f = await fixture(t);
  const editor = new Editor({ requestRender() {}, terminal: { rows: 40 } } as unknown as TUI, theme);
  editor.setAutocompleteProvider(f.provider);
  editor.setText("Use /");
  editor.handleInput("\t");
  await t.waitFor(() => assert.equal(editor.isShowingAutocomplete(), true), { timeout: 1000, interval: 5 });
  assert.match(editor.render(100).join("\n"), /spell-check/);
  editor.handleInput("\u001b[B");
  editor.handleInput("\t");
  assert.equal(editor.getText().trimEnd(), "Use /b");
});

for (const text of ["Use ", "Use\n", ""]) {
  test(`typing slash opens native completion without Tab after ${JSON.stringify(text)}`, async t => {
    const f = await fixture(t);
    const editor = f.editor();
    editor.setText(text);
    editor.handleInput("/");
    await t.waitFor(() => assert.equal(editor.isShowingAutocomplete(), true), { timeout: 1000, interval: 5 });
    assert.match(editor.render(100).join("\n"), /spell-check/);
    editor.handleInput("s");
    editor.handleInput("p");
    await t.waitFor(() => assert.doesNotMatch(editor.render(100).join("\n"), /\/a|\/b/), { timeout: 1000, interval: 5 });
    editor.handleInput("\t");
    assert.equal(editor.getText().trimEnd(), `${text}/spell-check`);
  });
}

test("typing a path slash does not open skill completion", async t => {
  const f = await fixture(t);
  const editor = f.editor();
  editor.setText("Use ./");
  editor.handleInput("/");
  assert.equal(editor.isShowingAutocomplete(), false);
  assert.equal(editor.getText(), "Use .//");
});

test("reads the current skill registry when suggesting completions", async t => {
  const f = await fixture(t);
  f.commands.splice(0, 2);
  assert.deepEqual(
    (await f.suggest(["Use /"]))?.items.map(item => item.value),
    ["/spell-check"],
  );
});
