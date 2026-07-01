import { useCallback, useEffect, useRef, useState } from "react";
import { IoHeadset, IoMic, IoMicOff, IoVideocam, IoVideocamOff } from "react-icons/io5";
import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client";
import type { LooseState } from "../state";
import { api } from "../lib/api";

/** A media tile, keyed by participant identity. Mirrors LiveKit participants. */
interface Tile {
  identity: string;
  name: string;
  isLocal: boolean;
  videoTrack: Track | null;
  micEnabled: boolean;
}

type MediaStatus =
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "not-configured" }
  | { kind: "roster-only" } // configured but no media (e.g. connect failed)
  | { kind: "error"; message: string };

/**
 * Renders the active huddle for `channelId`. Owns the LiveKit Room lifecycle:
 * connects on mount, disconnects + stops local tracks on unmount / leave.
 * The WS roster (state.huddleFor) is the source of truth for presence; LiveKit
 * tiles only enrich those entries with live audio/video.
 */
export function HuddlePanel({
  state,
  channelId,
  channelName,
}: {
  state: LooseState;
  channelId: string;
  channelName: string;
}) {
  const roomRef = useRef<Room | null>(null);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [status, setStatus] = useState<MediaStatus>({ kind: "connecting" });
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(false);

  const { leaveHuddle } = state;
  const roster = state.huddleFor(channelId);

  // Rebuild the tile list from the room's current participants.
  const syncTiles = useCallback((room: Room) => {
    const next: Tile[] = [];
    const lp = room.localParticipant;
    next.push({
      identity: lp.identity,
      name: lp.name || lp.identity,
      isLocal: true,
      videoTrack:
        lp.getTrackPublication(Track.Source.Camera)?.videoTrack ?? null,
      micEnabled: lp.isMicrophoneEnabled,
    });
    for (const p of room.remoteParticipants.values()) {
      next.push({
        identity: p.identity,
        name: p.name || p.identity,
        isLocal: false,
        videoTrack:
          p.getTrackPublication(Track.Source.Camera)?.videoTrack ?? null,
        micEnabled: p.getTrackPublication(Track.Source.Microphone)
          ? !p.getTrackPublication(Track.Source.Microphone)!.isMuted
          : false,
      });
    }
    setTiles(next);
  }, []);

  // Connect to LiveKit (or stay roster-only) on mount / channel change.
  useEffect(() => {
    let cancelled = false;
    const room = new Room();
    roomRef.current = room;

    const onUpdate = () => {
      if (!cancelled) syncTiles(room);
    };
    room.on(RoomEvent.ParticipantConnected, onUpdate);
    room.on(RoomEvent.ParticipantDisconnected, onUpdate);
    room.on(RoomEvent.TrackSubscribed, onUpdate);
    room.on(RoomEvent.TrackUnsubscribed, onUpdate);
    room.on(RoomEvent.TrackMuted, onUpdate);
    room.on(RoomEvent.TrackUnmuted, onUpdate);
    room.on(RoomEvent.LocalTrackPublished, onUpdate);
    room.on(RoomEvent.LocalTrackUnpublished, onUpdate);

    (async () => {
      try {
        const res = await api.huddleToken(channelId);
        if (cancelled) return;
        if (!res.configured || !res.url || !res.token) {
          setStatus({ kind: "not-configured" });
          return;
        }
        await room.connect(res.url, res.token);
        if (cancelled) {
          room.disconnect();
          return;
        }
        await room.localParticipant.setMicrophoneEnabled(true);
        if (cancelled) {
          room.disconnect();
          return;
        }
        setStatus({ kind: "connected" });
        setMicOn(true);
        setCamOn(false);
        syncTiles(room);
      } catch (err) {
        if (cancelled) return;
        // Do not block the UI; the WS roster still shows who's present.
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to connect to audio/video",
        });
      }
    })();

    return () => {
      cancelled = true;
      room.removeAllListeners();
      // stop local tracks + disconnect
      try {
        room.localParticipant.setMicrophoneEnabled(false);
        room.localParticipant.setCameraEnabled(false);
      } catch {
        /* ignore */
      }
      room.disconnect();
      if (roomRef.current === room) roomRef.current = null;
    };
  }, [channelId, syncTiles]);

  async function toggleMic() {
    const room = roomRef.current;
    if (!room || status.kind !== "connected") return;
    const next = !micOn;
    await room.localParticipant.setMicrophoneEnabled(next);
    setMicOn(next);
    syncTiles(room);
  }

  async function toggleCam() {
    const room = roomRef.current;
    if (!room || status.kind !== "connected") return;
    const next = !camOn;
    await room.localParticipant.setCameraEnabled(next);
    setCamOn(next);
    syncTiles(room);
  }

  function leave() {
    leaveHuddle(channelId);
  }

  // Build the rendered roster: prefer the authoritative WS list, enriching each
  // entry with a matching LiveKit tile when present.
  const rosterEntries = roster?.participants ?? [];
  const tileByName = new Map(tiles.map((t) => [t.name, t]));
  const tileById = new Map(tiles.map((t) => [t.identity, t]));

  return (
    <div className="huddle-panel">
      <div className="huddle-bar">
        <span className="huddle-title"><IoHeadset /> Huddle · {channelName}</span>
        <span className="huddle-status">
          {status.kind === "connecting" && "Connecting…"}
          {status.kind === "connected" && `${rosterEntries.length} in huddle`}
          {status.kind === "roster-only" && "In huddle (no media)"}
          {status.kind === "not-configured" &&
            "Live audio/video not configured (set LiveKit env on the server)"}
          {status.kind === "error" && `Audio/video unavailable: ${status.message}`}
        </span>
        <div className="huddle-controls">
          <button
            className={`huddle-ctl ${micOn ? "on" : "off"}`}
            onClick={toggleMic}
            disabled={status.kind !== "connected"}
            title={micOn ? "Mute" : "Unmute"}
          >
            {micOn ? (
              <>
                <IoMic /> Mic
              </>
            ) : (
              <>
                <IoMicOff /> Muted
              </>
            )}
          </button>
          <button
            className={`huddle-ctl ${camOn ? "on" : "off"}`}
            onClick={toggleCam}
            disabled={status.kind !== "connected"}
            title={camOn ? "Turn camera off" : "Turn camera on"}
          >
            {camOn ? (
              <>
                <IoVideocam /> Cam
              </>
            ) : (
              <>
                <IoVideocamOff /> Cam off
              </>
            )}
          </button>
          <button className="huddle-ctl leave" onClick={leave} title="Leave huddle">
            Leave
          </button>
        </div>
      </div>

      <div className="huddle-tiles">
        {rosterEntries.length === 0 && (
          <div className="huddle-empty">Waiting for participants…</div>
        )}
        {rosterEntries.map((p) => {
          const tile = tileById.get(p.userId) ?? tileByName.get(p.userName);
          return (
            <ParticipantTile
              key={p.userId}
              name={p.userName}
              isLocal={tile?.isLocal ?? false}
              videoTrack={tile?.videoTrack ?? null}
              micEnabled={tile?.micEnabled ?? false}
              hasMedia={status.kind === "connected" && !!tile}
            />
          );
        })}
      </div>

      {/* Hidden audio sink for all remote audio tracks. */}
      <RemoteAudio room={roomRef} />
    </div>
  );
}

function ParticipantTile({
  name,
  isLocal,
  videoTrack,
  micEnabled,
  hasMedia,
}: {
  name: string;
  isLocal: boolean;
  videoTrack: Track | null;
  micEnabled: boolean;
  hasMedia: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !videoTrack) return;
    videoTrack.attach(el);
    return () => {
      videoTrack.detach(el);
    };
  }, [videoTrack]);

  return (
    <div className="huddle-tile">
      {videoTrack ? (
        <video ref={videoRef} autoPlay playsInline muted={isLocal} />
      ) : (
        <div className="huddle-avatar">{name.slice(0, 1).toUpperCase()}</div>
      )}
      <div className="huddle-tile-foot">
        <span className="huddle-mic">
          {hasMedia ? micEnabled ? <IoMic /> : <IoMicOff /> : "•"}
        </span>
        <span className="huddle-name">
          {name}
          {isLocal && " (you)"}
        </span>
      </div>
    </div>
  );
}

/**
 * Attaches every subscribed remote audio track to a hidden <audio> element so
 * the huddle is audible. Tracks are managed imperatively via room events.
 */
function RemoteAudio({ room }: { room: React.MutableRefObject<Room | null> }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const r = room.current;
    if (!r) return;
    const container = containerRef.current;
    if (!container) return;
    const elements = new Map<string, HTMLAudioElement>();

    const attach = (
      track: RemoteTrack,
      pub: RemoteTrackPublication,
      _participant: RemoteParticipant,
    ) => {
      if (track.kind !== Track.Kind.Audio) return;
      const el = track.attach() as HTMLAudioElement;
      el.autoplay = true;
      container.appendChild(el);
      elements.set(pub.trackSid, el);
    };
    const detach = (track: RemoteTrack, pub: RemoteTrackPublication) => {
      if (track.kind !== Track.Kind.Audio) return;
      track.detach();
      const el = elements.get(pub.trackSid);
      if (el) {
        el.remove();
        elements.delete(pub.trackSid);
      }
    };

    r.on(RoomEvent.TrackSubscribed, attach);
    r.on(RoomEvent.TrackUnsubscribed, detach);

    return () => {
      r.off(RoomEvent.TrackSubscribed, attach);
      r.off(RoomEvent.TrackUnsubscribed, detach);
      for (const el of elements.values()) el.remove();
      elements.clear();
    };
  });

  return <div ref={containerRef} className="huddle-audio-sink" style={{ display: "none" }} />;
}
