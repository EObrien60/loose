import { useRef, useState } from "react";

export function Composer({
  placeholder,
  onSend,
  onTyping,
  onAttach,
  onAsk,
}: {
  placeholder: string;
  onSend: (body: string) => void;
  onTyping: () => void;
  /** Upload a file to the current channel. Provided -> shows the 📎 control. */
  onAttach?: (file: File) => Promise<void>;
  /** Send the current draft as an agent prompt. Provided -> shows the ✨ control. */
  onAsk?: (prompt: string) => void;
}) {
  const [value, setValue] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function submit() {
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue("");
  }

  function ask() {
    if (!onAsk) return;
    const text = value.trim();
    if (!text) return;
    onAsk(text);
    setValue("");
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
          <input
            ref={fileRef}
            type="file"
            style={{ display: "none" }}
            onChange={pickFile}
          />
          <button
            className="composer-icon"
            title="Attach a file"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? "…" : "📎"}
          </button>
        </>
      )}
      <input
        value={value}
        placeholder={uploading ? "Uploading…" : placeholder}
        onChange={(e) => {
          setValue(e.target.value);
          if (e.target.value) onTyping();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {onAsk && (
        <button
          className="composer-icon ask"
          title="Ask Assistant"
          onClick={ask}
        >
          ✨
        </button>
      )}
      <button onClick={submit}>Send</button>
    </div>
  );
}
