import { useMemo, useRef, useState } from "react";
import { IoAttach, IoSparklesOutline } from "react-icons/io5";

export interface Mentionable {
  id: string;
  name: string;
}

export function Composer({
  placeholder,
  onSend,
  onTyping,
  onAttach,
  onAsk,
  people = [],
}: {
  placeholder: string;
  onSend: (body: string) => void;
  onTyping: () => void;
  /** Upload a file to the current channel. Provided -> shows the attach control. */
  onAttach?: (file: File) => Promise<void>;
  /** Send the current draft as an agent prompt. Provided -> shows the ask control. */
  onAsk?: (prompt: string) => void;
  /** People available for @-mention autocomplete. */
  people?: Mentionable[];
}) {
  const [value, setValue] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // @-mention autocomplete state: the active "@query" span and the highlighted option.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [hi, setHi] = useState(0);

  const matches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return people
      .filter((p) => p.name.toLowerCase().includes(q))
      .slice(0, 6);
  }, [mention, people]);
  const showMenu = mention !== null && matches.length > 0;

  function syncMention(v: string, caret: number) {
    const upto = v.slice(0, caret);
    const m = upto.match(/(?:^|\s)@([^\s@]*)$/);
    if (m) {
      setMention({ start: caret - m[1].length - 1, query: m[1] });
      setHi(0);
    } else {
      setMention(null);
    }
  }

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setValue(v);
    if (v) onTyping();
    syncMention(v, e.target.selectionStart ?? v.length);
  }

  function pick(name: string) {
    if (!mention) return;
    const before = value.slice(0, mention.start);
    const after = value.slice(mention.start + 1 + mention.query.length);
    const insert = `@${name} `;
    const next = before + insert + after;
    setValue(next);
    setMention(null);
    const caret = (before + insert).length;
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
  }

  function submit() {
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue("");
    setMention(null);
  }

  function ask() {
    if (!onAsk) return;
    const text = value.trim();
    if (!text) return;
    onAsk(text);
    setValue("");
    setMention(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (showMenu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHi((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHi((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(matches[hi].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  async function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file || !onAttach) return;
    setUploading(true);
    try {
      await onAttach(file);
    } catch {
      /* swallow; server error surfaces via the channel */
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="composer">
      {onAttach && (
        <>
          <input ref={fileRef} type="file" style={{ display: "none" }} onChange={pickFile} />
          <button
            className="composer-icon"
            title="Attach a file"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? "…" : <IoAttach />}
          </button>
        </>
      )}
      <div className="composer-input-wrap">
        {showMenu && (
          <div className="mention-pop">
            {matches.map((p, i) => (
              <button
                key={p.id}
                className={`mention-opt ${i === hi ? "active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(p.name);
                }}
                onMouseEnter={() => setHi(i)}
              >
                <span className="mention-opt-avatar">{p.name.slice(0, 1).toUpperCase()}</span>
                <span className="mention-opt-name">{p.name}</span>
              </button>
            ))}
          </div>
        )}
        <input
          ref={inputRef}
          value={value}
          placeholder={uploading ? "Uploading…" : placeholder}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onBlur={() => setMention(null)}
        />
      </div>
      {onAsk && (
        <button className="composer-icon ask" title="Ask Assistant" onClick={ask}>
          <IoSparklesOutline />
        </button>
      )}
      <button onClick={submit}>Send</button>
    </div>
  );
}
