import type { ReactNode } from "react";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Render message text with `@Name` mentions highlighted. Names are matched against the
 * known people list (longest first so multi-word names win). The current user's own
 * mentions get an extra `.mention-self` class.
 */
export function renderWithMentions(
  text: string,
  names: string[],
  meName?: string,
): ReactNode {
  if (!text || names.length === 0) return text;
  const alts = [...names]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join("|");
  if (!alts) return text;
  const re = new RegExp("@(" + alts + ")\\b", "g");

  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const name = m[1];
    const self = meName != null && name === meName;
    out.push(
      <span key={key++} className={self ? "mention mention-self" : "mention"}>
        @{name}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last === 0) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}
