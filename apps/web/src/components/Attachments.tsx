import { IoDocumentOutline } from "react-icons/io5";
import type { Attachment } from "@loose/core";
import { fileUrl } from "../lib/api";

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export function Attachments({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="attachments">
      {attachments.map((a) => {
        const href = fileUrl(a.url);
        if (a.mime.startsWith("image/")) {
          return (
            <a
              key={a.id}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="attach-image"
            >
              <img src={href} alt={a.name} />
            </a>
          );
        }
        return (
          <a
            key={a.id}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            download={a.name}
            className="attach-chip"
          >
            <span className="attach-icon"><IoDocumentOutline /></span>
            <span className="attach-meta">
              <span className="attach-name">{a.name}</span>
              <span className="attach-size">{humanSize(a.size)}</span>
            </span>
          </a>
        );
      })}
    </div>
  );
}
