import { useState } from "react";
import { SafeAreaView, StyleSheet, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import type { Channel, User } from "@loose/core";
import { AuthScreen } from "./src/AuthScreen";
import { ChannelListScreen } from "./src/ChannelListScreen";
import { ChannelScreen } from "./src/ChannelScreen";
import { useLoose } from "./src/state";
import { colors } from "./src/theme";

interface Session {
  sessionToken: string;
  user: User;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      {session ? (
        <Authed
          sessionToken={session.sessionToken}
          user={session.user}
          onLogout={() => setSession(null)}
        />
      ) : (
        <AuthScreen onAuthed={(sessionToken, user) => setSession({ sessionToken, user })} />
      )}
    </SafeAreaView>
  );
}

function Authed({
  sessionToken,
  user,
  onLogout,
}: {
  sessionToken: string;
  user: User;
  onLogout: () => void;
}) {
  const loose = useLoose(sessionToken, user);
  const [openChannel, setOpenChannel] = useState<Channel | null>(null);

  return (
    <View style={styles.flex}>
      {openChannel ? (
        <ChannelScreen channel={openChannel} loose={loose} onBack={() => setOpenChannel(null)} />
      ) : (
        <ChannelListScreen
          channels={loose.channels}
          meId={loose.me.id}
          status={loose.status}
          onOpenChannel={setOpenChannel}
          onLogout={onLogout}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
});
