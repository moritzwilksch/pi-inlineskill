import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import {
  CustomEditor,
  SkillInvocationMessageComponent,
  stripFrontmatter,
  type ExtensionAPI,
  type ParsedSkillBlock,
  type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";

const messageType = "inline-skill";

type SkillBlock = Omit<ParsedSkillBlock, "userMessage">;

// Consume code literals before looking for standalone skill references.
const references =
  /^ {0,3}(?<fence>`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\k<fence>(?:`*|~*)[ \t]*(?=\r?$)|(?![\s\S]))|(?<ticks>`+)[\s\S]*?\k<ticks>(?!`)|(?<![\w./\\:])\/(?:skill:)?(?<name>[a-z0-9]+(?:-[a-z0-9]+)*)(?![\w/:-]|\.[\w])/gm;

function skillReferences(text: string, commands: SlashCommandInfo[]) {
  const skills = new Map(commands.filter(command => command.source === "skill").map(command => [command.name.slice(6), command]));
  const selected = new Map<string, SlashCommandInfo>();
  const replaced = text.replace(references, (match, ...args) => {
    const groups = args.at(-1) as { name?: string };
    const offset = args.at(-3) as number;
    if (!groups.name) return match;
    const skill = skills.get(groups.name);
    if (!skill) return match;
    // Leading prompt commands keep their native meaning when a skill shares the name.
    if (offset === 0 && commands.some(command => command.source !== "skill" && match === `/${command.name}`)) return match;
    selected.set(groups.name, skill);
    return `skill:${groups.name}`;
  });
  return { text: replaced, skills: selected };
}

const skillPrefix = /(?<![\w./\\:@])\/(?:skill:)?[a-z0-9-]*$/;

function skillAutocomplete(current: AutocompleteProvider, pi: ExtensionAPI): AutocompleteProvider {
  return {
    triggerCharacters: current.triggerCharacters,
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const before = lines[cursorLine].slice(0, cursorCol);
      const prefix = before.match(skillPrefix)?.[0];
      // Pi routes inline Tab through force:true, not its slash-command trigger.
      if (!prefix) return current.getSuggestions(lines, cursorLine, cursorCol, options);
      const start = lines.slice(0, cursorLine).join("\n").length + (cursorLine > 0 ? 1 : 0) + cursorCol - prefix.length;
      const inCode = [...lines.join("\n").matchAll(references)].some(
        match => !match.groups?.name && match.index <= start && match.index + match[0].length > start,
      );
      if (inCode) return current.getSuggestions(lines, cursorLine, cursorCol, options);
      const qualified = prefix.startsWith("/skill:");
      const items = pi
        .getCommands()
        .filter(command => command.source === "skill")
        .map(command => {
          const value = `/${qualified ? command.name : command.name.slice(6)}`;
          return { value, label: value, description: command.description, inlineSkill: true };
        })
        .filter(item => item.value.startsWith(prefix));
      if (items.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
      const native = before.trimStart() === prefix ? await current.getSuggestions(lines, cursorLine, cursorCol, { ...options, force: false }) : null;
      return { prefix, items: [...(native?.prefix === prefix ? native.items.filter(item => !item.value.startsWith("skill:")) : []), ...items] };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if ("inlineSkill" in item && !lines[cursorLine].slice(0, cursorCol - prefix.length).trim()) {
        item = { ...item, value: item.value.slice(1) };
      }
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
      skillPrefix.test(lines[cursorLine].slice(0, cursorCol)) || (current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false),
  };
}

class InlineSkillEditor extends CustomEditor {
  handleInput(data: string): void {
    super.handleInput(data);
    if (data !== "/" || this.isShowingAutocomplete()) return;
    const { line, col } = this.getCursor();
    if (/(?:^|\s)\/$/.test(this.getLines()[line].slice(0, col))) {
      // Pi ignores '/' in provider triggers. Reuse its completion action instead.
      super.handleInput("\t");
    }
  }
}

export default function inlineSkills(pi: ExtensionAPI): void {
  // Reuse Pi's collapsed `[skill] name` look; the model still receives the full block.
  pi.registerMessageRenderer<SkillBlock>(messageType, (message, { expanded, outputPad }) => {
    if (!message.details) return undefined;
    const component = new SkillInvocationMessageComponent({ ...message.details, userMessage: undefined }, undefined, outputPad);
    component.setExpanded(expanded);
    return component;
  });
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.addAutocompleteProvider(current => skillAutocomplete(current, pi));
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new InlineSkillEditor(tui, theme, keybindings));
  });
  pi.on("input", async (event, ctx) => {
    const expanded = skillReferences(event.text, pi.getCommands());
    if (expanded.skills.size === 0) return { action: "continue" };

    const blocks: SkillBlock[] = [];
    for (const [name, skill] of expanded.skills) {
      const path = skill.sourceInfo.path;
      let content: string;
      try {
        content = await readFile(path, "utf8");
      } catch (error) {
        // Never submit a partial expansion that makes the agent load the missing skill.
        ctx.ui.notify(`Cannot load skill:${name} from ${path}: ${error instanceof Error ? error.message : String(error)}`, "error");
        return { action: "handled" };
      }
      blocks.push({ name, location: path, content: `References are relative to ${dirname(path)}.\n\n${stripFrontmatter(content).trim()}` });
    }
    // Messages sent here land before the prompt: appended now when idle, queued ahead of it while streaming.
    for (const block of blocks) {
      pi.sendMessage(
        {
          customType: messageType,
          content: `<skill name="${block.name}" location="${block.location}">\n${block.content}\n</skill>`,
          display: true,
          details: block,
        },
        event.streamingBehavior ? { deliverAs: event.streamingBehavior } : undefined,
      );
    }
    return { action: "transform", text: expanded.text, images: event.images };
  });
}
