import { useEffect, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { Channel } from "@loose/core";
import { channelLabel, type LooseState, type UiMessage } from "./state";
import { colors } from "./theme";
import { timeLabel } from "./util";

interface Props {
  channel: Channel;
  loose: LooseState;
  onBack: () => void;
}

export function ChannelScreen({ channel, loose, onBack }: Props) {
  const [draft, setDraft] = useState("");

  useEffect(() => {
    loose.subscribe(channel.id);
  }, [channel.id, loose]);

  const data = loose.getChannelData(channel.id);
  const messages = data?.messages ?? [];

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    loose.sendMessage(channel.id, text);
    setDraft("");
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {channelLabel(channel, loose.me.id)}
        </Text>
        <View style={styles.backSpacer} />
      </View>

      <FlatList
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.empty}>{data?.loaded ? "No messages yet." : "Loading…"}</Text>
        }
        renderItem={({ item }) => (
          <MessageRow
            message={item}
            isOwn={item.userId === loose.me.id}
            onDelete={() => loose.deleteMessage(channel.id, item.id)}
          />
        )}
      />

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          placeholder={`Message ${channelLabel(channel, loose.me.id)}`}
          placeholderTextColor={colors.textDim}
          value={draft}
          onChangeText={setDraft}
          multiline
          onSubmitEditing={send}
        />
        <Pressable
          style={({ pressed }) => [styles.send, pressed && styles.sendPressed]}
          onPress={send}
        >
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function MessageRow({
  message,
  isOwn,
  onDelete,
}: {
  message: UiMessage;
  isOwn: boolean;
  onDelete: () => void;
}) {
  const tag =
    message.kind === "agent" ? "AGENT" : message.kind === "system" ? "SYSTEM" : null;
  const tagColor = message.kind === "agent" ? colors.agent : colors.system;
  const attachments = message.attachments ?? [];
  const deleted = message.deletedAt != null;
  const edited = !deleted && message.editedAt != null;

  const handleLongPress = () => {
    if (deleted || !isOwn || message.pending) return;
    Alert.alert("Message", undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: onDelete },
    ]);
  };

  return (
    <Pressable
      onLongPress={handleLongPress}
      style={[styles.msg, message.pending && styles.msgPending]}
    >
      <View style={styles.msgMeta}>
        <Text style={styles.author}>{message.userName}</Text>
        {tag && (
          <Text style={[styles.tag, { color: tagColor, borderColor: tagColor }]}>{tag}</Text>
        )}
        <Text style={styles.time}>{timeLabel(message.createdAt)}</Text>
      </View>
      {deleted ? (
        <Text style={styles.deleted}>This message was deleted.</Text>
      ) : (
        <Text style={styles.body}>
          {message.body}
          {edited && <Text style={styles.edited}> (edited)</Text>}
        </Text>
      )}
      {!deleted &&
        attachments.map((a) => (
          <Text key={a.id} style={styles.attachment}>
            📎 {a.name}
          </Text>
        ))}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
  },
  back: { color: colors.accent, fontSize: 16, width: 64 },
  backSpacer: { width: 64 },
  title: { color: colors.text, fontSize: 17, fontWeight: "600", flex: 1, textAlign: "center" },
  list: { padding: 12, flexGrow: 1 },
  empty: { color: colors.textDim, textAlign: "center", marginTop: 40 },
  msg: { marginBottom: 14 },
  msgPending: { opacity: 0.5 },
  msgMeta: { flexDirection: "row", alignItems: "center", marginBottom: 2 },
  author: { color: colors.text, fontWeight: "600", fontSize: 14 },
  tag: {
    fontSize: 10,
    fontWeight: "700",
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    marginLeft: 6,
  },
  time: { color: colors.textDim, fontSize: 11, marginLeft: 6 },
  body: { color: colors.text, fontSize: 15, lineHeight: 20 },
  deleted: { color: colors.textDim, fontSize: 15, lineHeight: 20, fontStyle: "italic" },
  edited: { color: colors.textDim, fontSize: 11 },
  attachment: { color: colors.accent, fontSize: 13, marginTop: 3 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: 8,
    borderTopColor: colors.border,
    borderTopWidth: 1,
  },
  input: {
    flex: 1,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    maxHeight: 120,
  },
  send: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginLeft: 8,
  },
  sendPressed: { opacity: 0.8 },
  sendText: { color: "#fff", fontWeight: "600" },
});
