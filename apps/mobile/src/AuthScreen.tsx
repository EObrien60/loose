import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { User } from "@loose/core";
import { api, ApiError } from "./api";
import { colors } from "./theme";

interface Props {
  onAuthed: (sessionToken: string, user: User) => void;
}

export function AuthScreen({ onAuthed }: Props) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const result =
        mode === "login"
          ? await api.login({ email: email.trim(), password })
          : await api.register({
              email: email.trim(),
              password,
              displayName: displayName.trim(),
            });
      onAuthed(result.sessionToken, result.user);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Loose</Text>
      <Text style={styles.subtitle}>
        {mode === "login" ? "Sign in to your workspace" : "Create an account"}
      </Text>

      <TextInput
        style={styles.input}
        placeholder="Email"
        placeholderTextColor={colors.textDim}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      {mode === "register" && (
        <TextInput
          style={styles.input}
          placeholder="Display name"
          placeholderTextColor={colors.textDim}
          value={displayName}
          onChangeText={setDisplayName}
        />
      )}
      <TextInput
        style={styles.input}
        placeholder="Password"
        placeholderTextColor={colors.textDim}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        disabled={busy}
        onPress={submit}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>{mode === "login" ? "Sign in" : "Register"}</Text>
        )}
      </Pressable>

      <Pressable onPress={() => setMode(mode === "login" ? "register" : "login")}>
        <Text style={styles.toggle}>
          {mode === "login" ? "Need an account? Register" : "Have an account? Sign in"}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", padding: 24 },
  title: { color: colors.text, fontSize: 36, fontWeight: "700", textAlign: "center" },
  subtitle: {
    color: colors.textDim,
    fontSize: 15,
    textAlign: "center",
    marginTop: 4,
    marginBottom: 28,
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    color: colors.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    marginBottom: 12,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 4,
  },
  buttonPressed: { opacity: 0.8 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  toggle: { color: colors.accent, textAlign: "center", marginTop: 18, fontSize: 14 },
  error: { color: colors.danger, marginBottom: 12, fontSize: 14 },
});
