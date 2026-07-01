import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { Channel } from "@loose/core";
import { channelLabel } from "./state";
import { colors } from "./theme";

interface Props {
  channels: Channel[];
  meId: string;
  status: "connecting" | "open" | "closed";
  onOpenChannel: (channel: Channel) => void;
  onLogout: () => void;
}

export function ChannelListScreen({ channels, meId, status, onOpenChannel, onLogout }: Props) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Channels</Text>
          <Text style={styles.status}>
            {status === "open" ? "Connected" : status === "connecting" ? "Connecting…" : "Offline"}
          </Text>
        </View>
        <Pressable onPress={onLogout} hitSlop={8}>
          <Text style={styles.logout}>Log out</Text>
        </Pressable>
      </View>

      <FlatList
        data={channels}
        keyExtractor={(c) => c.id}
        ListEmptyComponent={<Text style={styles.empty}>No channels yet.</Text>}
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => onOpenChannel(item)}
          >
            <Text style={styles.channelName}>{channelLabel(item, meId)}</Text>
            {item.topic ? (
              <Text style={styles.topic} numberOfLines={1}>
                {item.topic}
              </Text>
            ) : null}
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
  },
  title: { color: colors.text, fontSize: 22, fontWeight: "700" },
  status: { color: colors.textDim, fontSize: 12, marginTop: 2 },
  logout: { color: colors.accent, fontSize: 14 },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowPressed: { backgroundColor: colors.surfaceAlt },
  channelName: { color: colors.text, fontSize: 16, fontWeight: "500" },
  topic: { color: colors.textDim, fontSize: 13, marginTop: 2 },
  empty: { color: colors.textDim, textAlign: "center", marginTop: 40 },
});
