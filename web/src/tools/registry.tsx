// Every tool that can be placed on a project's grid. Builder mode lists
// these in its palette. Plugins come from the server's plugin list.
import type { ReactNode } from "react";
import type { PluginConfigField, PluginMeta, Tool, ToolCategory } from "../../../shared/types.ts";
import { LinkTool } from "./LinkTool.tsx";
import { NotesModule } from "./NotesModule.tsx";
import { PluginTool } from "./PluginTool.tsx";
import { AnalyticsModule, analyticsDef } from "./AnalyticsModule.tsx";

export interface Size {
  w: number;
  h: number;
  /** Spoken description, e.g. "2 wide, 1 tall". Builder mode draws the shape. */
  label: string;
}

export interface ToolDef {
  /** Unique key, e.g. "link", "notes", "plugin:github". */
  key: string;
  category: ToolCategory;
  type: string;
  name: string;
  description: string;
  sizes: Size[];
  configFields: PluginConfigField[];
  /** Plugin tokens and whether they're set in .env. */
  env?: PluginMeta["env"];
  render(tool: Tool, onData: (data: Tool["data"]) => void): ReactNode;
  /** Loads choices for "select" fields (and a note) when the settings open. */
  loadSettings?(): Promise<{ options?: Record<string, NonNullable<PluginConfigField["options"]>>; note?: string }>;
  /** An extra button in the settings, e.g. "Collect now". Returns a message to show. */
  settingsAction?: { label: string; run(): Promise<string> };
}

const LINK_SIZES: Size[] = [
  { w: 1, h: 1, label: "1 wide, 1 tall" },
  { w: 2, h: 1, label: "2 wide, 1 tall" },
  { w: 3, h: 1, label: "3 wide, 1 tall" },
];

const PANEL_SIZES: Size[] = [
  { w: 2, h: 2, label: "2 wide, 2 tall" },
  { w: 3, h: 2, label: "3 wide, 2 tall" },
  { w: 2, h: 3, label: "2 wide, 3 tall" },
  { w: 3, h: 3, label: "3 wide, 3 tall" },
  { w: 4, h: 3, label: "4 wide, 3 tall" },
  { w: 4, h: 4, label: "4 wide, 4 tall" },
];

export function buildRegistry(plugins: PluginMeta[]): ToolDef[] {
  return [
    {
      key: "link",
      category: "link",
      type: "link",
      name: "Link",
      description: "Opens a website or a file on this computer.",
      sizes: LINK_SIZES,
      configFields: [
        { key: "url", label: "Link or file path", placeholder: "https://… or C:\\path\\file.pdf", required: true },
        { key: "title", label: "Name (optional)", placeholder: "Uses the site's name if empty" },
      ],
      render: (tool) => <LinkTool tool={tool} />,
    },
    {
      key: "notes",
      category: "module",
      type: "notes",
      name: "Notes",
      description: "Rich text notes with lists, numbering, highlight and color.",
      sizes: PANEL_SIZES,
      configFields: [],
      render: (tool, onData) => <NotesModule tool={tool} onData={onData} />,
    },
    { ...analyticsDef, render: (tool) => <AnalyticsModule tool={tool} /> },
    ...plugins.map(
      (p): ToolDef => ({
        key: `plugin:${p.id}`,
        category: "plugin",
        type: p.id,
        name: p.name,
        description: p.description,
        sizes: PANEL_SIZES,
        configFields: p.configFields,
        env: p.env,
        render: (tool) => <PluginTool tool={tool} name={p.name} env={p.env} />,
      }),
    ),
  ];
}

export const defKey = (t: Pick<Tool, "category" | "type">) => (t.category === "plugin" ? `plugin:${t.type}` : t.type);
