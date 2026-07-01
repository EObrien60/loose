import type { LiveAgentRun } from "../state";

/** A streaming agent run bubble shown while tokens accumulate. */
export function AgentBubble({ run }: { run: LiveAgentRun }) {
  return (
    <div className="msg agent-live">
      <div className="msg-head">
        <span className="author nonhuman">{run.agentName}</span>
        <span className="kind-badge">agent</span>
        <span className="ts">thinking…</span>
      </div>
      <div className="body">
        {run.text}
        <span className="agent-cursor" />
      </div>
    </div>
  );
}
