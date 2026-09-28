// Notes module: rich text saved to the project. Supports bold, italic,
// bullet and numbered lists, highlight colors and text colors.
import { useEffect, useRef } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import type { Tool } from "../../../shared/types.ts";

// A small palette that still reads well on a black/white page.
const TEXT_COLORS = ["#000000", "#d11a2a", "#1a56d1", "#1a8a3a", "#8a8a8a"];
const HIGHLIGHTS = ["#fff200", "#9cf5b0", "#a8d8ff", "#ffb3c7"];

export function NotesModule({ tool, onData }: { tool: Tool; onData: (data: Tool["data"]) => void }) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const editor = useEditor({
    extensions: [StarterKit, Highlight.configure({ multicolor: true }), TextStyle, Color],
    content: (tool.data.doc as object) ?? "",
    editorProps: { attributes: { class: "notes-editor" } },
    onUpdate: ({ editor }) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => onData({ ...tool.data, doc: editor.getJSON() }), 500);
    },
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e?.isActive("bold") ?? false,
      italic: e?.isActive("italic") ?? false,
      bullet: e?.isActive("bulletList") ?? false,
      ordered: e?.isActive("orderedList") ?? false,
    }),
  });

  if (!editor) return null;
  const chain = () => editor.chain().focus();

  return (
    <div className="notes">
      <div className="notes-toolbar" onMouseDown={(e) => e.preventDefault()}>
        <button className={state?.bold ? "on" : ""} onClick={() => chain().toggleBold().run()} title="Bold">
          <b>B</b>
        </button>
        <button className={state?.italic ? "on" : ""} onClick={() => chain().toggleItalic().run()} title="Italic">
          <i>I</i>
        </button>
        <button className={state?.bullet ? "on" : ""} onClick={() => chain().toggleBulletList().run()} title="Bullet list">
          •
        </button>
        <button className={state?.ordered ? "on" : ""} onClick={() => chain().toggleOrderedList().run()} title="Numbered list">
          1.
        </button>
        <span className="sep" />
        {TEXT_COLORS.map((c) => (
          <button key={c} className="swatch text" title="Text color" onClick={() => chain().setColor(c).run()}>
            <span style={{ color: c }}>A</span>
          </button>
        ))}
        <span className="sep" />
        {HIGHLIGHTS.map((c) => (
          <button key={c} className="swatch" title="Highlight" onClick={() => chain().toggleHighlight({ color: c }).run()}>
            <span className="swatch-fill" style={{ background: c }} />
          </button>
        ))}
        <button title="Clear formatting" onClick={() => chain().unsetAllMarks().run()}>
          ⌫
        </button>
      </div>
      <EditorContent editor={editor} className="notes-body" />
    </div>
  );
}
