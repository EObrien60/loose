/**
 * LLM port for agent runs. Swap with LLM_DRIVER (default: `anthropic` if ANTHROPIC_API_KEY
 * is set, else `echo`). A new provider (OpenAI, Gemini, local model, …) = a class implementing
 * LlmProvider + a case in createLlm(). Nothing else changes.
 */
export interface LlmStreamInput {
  system: string;
  prompt: string;
  context: string;
}

export interface LlmProvider {
  driver: string;
  /** Stream the reply token-by-token via onDelta; resolve with the full text. */
  stream(input: LlmStreamInput, onDelta: (text: string) => void): Promise<string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deterministic local fallback — no external calls, so the agent surface works keyless. */
class EchoLlm implements LlmProvider {
  driver = "echo";
  async stream(input: LlmStreamInput, onDelta: (t: string) => void): Promise<string> {
    const reply =
      `Here's my take on "${input.prompt.slice(0, 120)}". ` +
      `I reviewed the recent conversation for context. ` +
      `(LLM_DRIVER=echo — set ANTHROPIC_API_KEY or another provider for full responses.)`;
    let full = "";
    for (const word of reply.split(" ")) {
      const chunk = word + " ";
      full += chunk;
      onDelta(chunk);
      await sleep(8);
    }
    return full.trim();
  }
}

class AnthropicLlm implements LlmProvider {
  driver = "anthropic";
  constructor(private model: string) {}
  async stream(input: LlmStreamInput, onDelta: (t: string) => void): Promise<string> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const s = client.messages.stream({
      model: this.model,
      max_tokens: 2048,
      system: input.system,
      messages: [{ role: "user", content: `Recent conversation:\n${input.context || "(empty)"}\n\nUser request: ${input.prompt}` }],
    });
    s.on("text", (t: string) => onDelta(t));
    const final = await s.finalMessage();
    return final.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  }
}

export function createLlm(): LlmProvider {
  const driver = process.env.LLM_DRIVER ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : "echo");
  if (driver === "anthropic") return new AnthropicLlm(process.env.LOOSE_AGENT_MODEL ?? "claude-opus-4-8");
  return new EchoLlm();
}
