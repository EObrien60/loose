import { nanoid } from "nanoid";
import type { Store } from "./store";
import type { PubSub } from "./pubsub";
import type { LlmProvider } from "./llm";

const AGENT_NAME = "Assistant";

export interface AgentInvoke {
  channelId: string;
  threadRootId?: string;
  prompt: string;
}

/**
 * Run an agent in a channel/thread: stream tokens as `agent.run.delta`, persist a final
 * `agent` message, emit `agent.run.done`. The LLM is a swappable port (see ./llm).
 */
export async function runAgent(
  deps: { store: Store; pubsub: PubSub; llm: LlmProvider },
  invoke: AgentInvoke,
): Promise<void> {
  const { store, pubsub, llm } = deps;
  const runId = `run_${nanoid(8)}`;
  const { channelId, threadRootId, prompt } = invoke;

  const { messages } = await store.history(channelId, 30);
  const context = messages
    .filter((m) => (threadRootId ? m.threadRootId === threadRootId || m.id === threadRootId : !m.threadRootId))
    .map((m) => `${m.userName}: ${m.body}`)
    .join("\n");

  const system = await store.systemUser();
  const emit = (text: string) =>
    void pubsub.publish(channelId, { type: "agent.run.delta", runId, channelId, threadRootId: threadRootId ?? null, agentName: AGENT_NAME, text });

  let full = "";
  try {
    full = await llm.stream(
      { system: `You are ${AGENT_NAME}, a concise, helpful agent inside the Loose dev-team chat. Answer directly.`, prompt, context },
      emit,
    );
  } catch (err) {
    emit(`\n[agent error: ${err instanceof Error ? err.message : "unknown"}]`);
  }

  const message = await store.append({
    channelId,
    userId: system.id,
    userName: AGENT_NAME,
    kind: "agent",
    body: full.trim() || "(no response)",
    threadRootId,
  });
  await pubsub.publish(channelId, { type: "message.new", message });
  await pubsub.publish(channelId, { type: "agent.run.done", runId, channelId, messageId: message.id });
}
