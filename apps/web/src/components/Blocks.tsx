import type { Block } from "@loose/core";

export function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <div className="block-card">
      {blocks.map((b, i) => {
        switch (b.type) {
          case "section":
            return (
              <p key={i} className="block-section">
                {b.text}
              </p>
            );
          case "context":
            return (
              <div key={i} className="block-context">
                {b.text}
              </div>
            );
          case "divider":
            return <hr key={i} className="block-divider" />;
          case "actions":
            return (
              <div key={i} className="block-actions">
                {b.buttons.map((btn, j) => (
                  <button
                    key={j}
                    className={`block-btn ${btn.style ?? "default"}`}
                    onClick={() => {
                      if (btn.url) window.open(btn.url, "_blank", "noopener,noreferrer");
                    }}
                  >
                    {btn.text}
                  </button>
                ))}
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
