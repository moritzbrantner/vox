import { createComputeClient, processingPolicyForServerUrl } from "@stutter-tracker/compute-client";
import {
  type AnalysisReport,
  canStartWithParticipants,
  type ConsentLedger,
  describeParticipants,
  EMPTY_CONSENT_LEDGER,
  OTHER_PARTICIPANTS_REQUIRED_MESSAGE,
  OTHER_PARTICIPANTS_STATEMENT,
  type OtherParticipantsConfirmation,
  participantsConfirmationForStart,
  type TranscriptionEngineId,
  type TranscriptionModelStatus,
} from "@stutter-tracker/shared";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { File } from "expo-file-system";
import { hasRemoteConsent, setRemoteConsent, withdrawOtherServerConsent } from "./src/consent";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Switch,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  mobileErrorMessage,
  recordingFileInfo,
  transcriptionToAnalysisRequest,
} from "./src/recording";
import {
  captureQualityMessage,
  mobileMetricRows,
  mobileRecordingDescriptor,
  withMobileCaptureQuality,
} from "./src/captureQuality";
import { createRecordingController } from "./src/recorder";

const RECORDING_PRESET = RecordingPresets.HIGH_QUALITY;

const providers: Array<Exclude<TranscriptionEngineId, "browser">> = [
  "whisperCpp",
  "whisperCli",
  "fasterWhisper",
];

export default function App() {
  const [serverUrl, setServerUrl] = useState("http://127.0.0.1:8787");
  const [apiToken, setApiToken] = useState("");
  const [provider, setProvider] = useState<Exclude<TranscriptionEngineId, "browser">>("whisperCpp");
  const [model, setModel] = useState("base.en");
  const [language, setLanguage] = useState("en-US");
  const [status, setStatus] = useState("Idle");
  const [isUploading, setIsUploading] = useState(false);
  const [permissionGranted, setPermissionGranted] = useState<boolean | null>(null);
  const [transcript, setTranscript] = useState("");
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [lastRecordingUri, setLastRecordingUri] = useState("");
  const [modelStatuses, setModelStatuses] = useState<TranscriptionModelStatus[]>([]);
  // "Only I speak": without it a result stays unknown, as on the web.
  const [soloSpeaker, setSoloSpeaker] = useState(false);
  // Recording other people needs a confirmation made for this session (#66); the agreement is
  // cleared whenever a recording ends, so it never carries over.
  const [othersRecorded, setOthersRecorded] = useState(false);
  const [othersAgreed, setOthersAgreed] = useState(false);
  const [lastParticipants, setLastParticipants] = useState<OtherParticipantsConfirmation | null>(
    null,
  );
  const audioRecorder = useAudioRecorder(RECORDING_PRESET);
  const recorderState = useAudioRecorderState(audioRecorder);
  useEffect(() => {
    if (!recorderState.isRecording) setOthersAgreed(false);
  }, [recorderState.isRecording]);
  // Start/stop/cancel go through one controller, so a late prepare or upload never attaches to
  // another capture.
  const recording = useMemo(() => createRecordingController(audioRecorder), [audioRecorder]);
  const captureRef = useRef<{
    soloSpeaker: boolean;
    otherParticipants: OtherParticipantsConfirmation | null;
  } | null>(null);
  useEffect(() => {
    return () => {
      void recording.cancel();
    };
  }, [recording]);
  // Consent is bound to the exact URL it was given for; editing the URL withdraws it.
  const [consentLedger, setConsentLedger] = useState<ConsentLedger>(EMPTY_CONSENT_LEDGER);
  const remoteConsent = hasRemoteConsent(consentLedger, serverUrl);
  // Each run captures one client, so an endpoint edit cannot redirect an in-flight run.
  const client = useMemo(
    () =>
      createComputeClient({
        processingPolicy: processingPolicyForServerUrl(serverUrl, remoteConsent),
        apiToken,
      }),
    [apiToken, serverUrl, remoteConsent],
  );
  const destination = client.destination;
  const isRemote =
    (destination.kind === "server" && destination.mode === "remote") ||
    (destination.kind === "blocked" && destination.needsRemoteConsent === true);

  useEffect(() => {
    let cancelled = false;
    async function prepareAudio() {
      try {
        const permission = await AudioModule.requestRecordingPermissionsAsync();
        if (cancelled) {
          return;
        }
        setPermissionGranted(permission.granted);
        if (!permission.granted) {
          setStatus("Microphone permission was denied");
          return;
        }
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      } catch (error) {
        if (!cancelled) {
          setStatus(mobileErrorMessage(error));
        }
      }
    }
    void prepareAudio();
    return () => {
      cancelled = true;
    };
  }, []);

  async function checkHealth() {
    setStatus("Checking server");
    try {
      const response = await fetch(`${serverUrl.replace(/\/+$/, "")}/health`, {
        headers: apiToken ? { authorization: `Bearer ${apiToken}` } : undefined,
      });
      setStatus(response.ok ? "Server reachable" : `Server returned ${response.status}`);
    } catch (error) {
      setStatus(mobileErrorMessage(error));
    }
  }

  async function loadModelStatuses() {
    setStatus("Loading models");
    try {
      const statuses = await client.transcriptionModels(provider);
      setModelStatuses(statuses);
      setStatus("Model status loaded");
    } catch (error) {
      setStatus(mobileErrorMessage(error));
    }
  }

  async function downloadSelectedModel() {
    setStatus(`Downloading ${model}`);
    try {
      const status = await client.downloadTranscriptionModel(provider, model);
      setModelStatuses((current) => [status, ...current.filter((item) => item.id !== status.id)]);
      setStatus(`${model} ready`);
    } catch (error) {
      setStatus(mobileErrorMessage(error));
    }
  }

  async function startRecording() {
    if (!permissionGranted) {
      setStatus("Microphone permission was denied");
      return;
    }
    // A session that records other people does not start without this session's confirmation.
    const participants = { othersRecorded, othersAgreed };
    if (!canStartWithParticipants(participants)) {
      setStatus(OTHER_PARTICIPANTS_REQUIRED_MESSAGE);
      return;
    }
    setReport(null);
    setTranscript("");
    setLastParticipants(null);
    setStatus("Preparing recording");
    // The declaration applies to the recording it was made for.
    const declaration = {
      soloSpeaker: soloSpeaker && !othersRecorded,
      otherParticipants: participantsConfirmationForStart(participants),
    };
    try {
      const captureId = await recording.start();
      if (!captureId) return;
      captureRef.current = declaration;
      setLastParticipants(declaration.otherParticipants);
      setStatus("Recording");
    } catch (error) {
      setStatus(mobileErrorMessage(error));
    }
  }

  async function stopRecording() {
    try {
      setStatus("Stopping recording");
      const captureSeconds = recorderState.durationMillis / 1000;
      const stopped = await recording.stop();
      if (!stopped) return;
      setLastRecordingUri(stopped.uri);
      await uploadRecording(
        stopped.captureId,
        stopped.uri,
        captureSeconds,
        captureRef.current?.soloSpeaker ?? false,
        captureRef.current?.otherParticipants ?? null,
      );
    } catch (error) {
      setStatus(mobileErrorMessage(error));
    }
  }

  async function cancelRecording() {
    await recording.cancel();
    setIsUploading(false);
    setStatus("Recording cancelled");
  }

  async function uploadRecording(
    captureId: string,
    uri: string,
    captureSeconds: number,
    declaredSolo: boolean,
    otherParticipants: OtherParticipantsConfirmation | null,
  ) {
    // Results of a cancelled or superseded capture are dropped.
    const isCurrent = () => recording.isCurrent(captureId);
    setIsUploading(true);
    setStatus("Uploading and transcribing");
    try {
      const file = new File(uri);
      const { filename, mimeType } = recordingFileInfo(uri);
      const result = await client.transcribeAudioFile({
        file: file as unknown as Blob,
        filename,
        mimeType,
        provider,
        model,
        language,
      });
      if (!isCurrent()) return;
      setTranscript(result.segments.map((segment) => segment.text).join(" "));
      setStatus("Analyzing transcript");
      const analyzed = await client.analyzeSpeechSession(transcriptionToAnalysisRequest(result));
      if (!isCurrent()) return;
      // The server's measurement of the decoded upload is the actual recorded format; the preset
      // is only what was requested.
      const descriptor = mobileRecordingDescriptor({
        sessionId: captureId,
        runId: `${captureId}-run-1`,
        sampleRate: result.captureMetrics?.sampleRate ?? RECORDING_PRESET.sampleRate,
        channelCount: result.captureMetrics?.channels ?? RECORDING_PRESET.numberOfChannels,
        soloSpeaker: declaredSolo,
        otherParticipants,
      });
      setReport(withMobileCaptureQuality(analyzed, result, descriptor, captureSeconds));
      setStatus("Complete");
    } catch (error) {
      if (isCurrent()) setStatus(mobileErrorMessage(error));
    } finally {
      if (isCurrent()) setIsUploading(false);
    }
  }

  const selectedModelStatus = modelStatuses.find((item) => item.id === model);
  const busy = isUploading || recorderState.isRecording;
  const qualityMessage = report ? captureQualityMessage(report) : null;

  return (
    <SafeAreaView style={styles.shell}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.eyebrow}>Stutter Tracker</Text>
          <Text style={styles.title}>Mobile Recorder</Text>
        </View>

        <Panel title="Compute server">
          <Field
            label="Server URL"
            value={serverUrl}
            onChangeText={(url) => {
              setServerUrl(url);
              setConsentLedger((ledger) => withdrawOtherServerConsent(ledger, url));
            }}
            editable={!busy}
          />
          <Field
            label="API token"
            value={apiToken}
            onChangeText={setApiToken}
            secureTextEntry
            editable={!busy}
          />
          <Text style={styles.detail} accessibilityRole="summary">
            Processing: {destination.label}
          </Text>
          {destination.kind === "blocked" && (
            <Text style={styles.detail}>{destination.reason}</Text>
          )}
          {isRemote && (
            <TouchableOpacity
              style={styles.button}
              disabled={busy}
              accessibilityRole="switch"
              accessibilityState={{ checked: remoteConsent }}
              onPress={() =>
                setConsentLedger((ledger) => setRemoteConsent(ledger, serverUrl, !remoteConsent))
              }
            >
              <Text style={styles.buttonText}>
                {remoteConsent
                  ? "Withdraw consent for remote analysis"
                  : "Allow sending recordings, transcripts and voiceprints to this remote server"}
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.button} onPress={checkHealth} disabled={busy}>
            <Text style={styles.buttonText}>Health</Text>
          </TouchableOpacity>
        </Panel>

        <Panel title="Transcription">
          <Field
            label="Provider"
            value={provider}
            onChangeText={(value) => {
              if (providers.includes(value as Exclude<TranscriptionEngineId, "browser">)) {
                setProvider(value as Exclude<TranscriptionEngineId, "browser">);
              }
            }}
          />
          <Field label="Model" value={model} onChangeText={setModel} />
          <Field label="Language" value={language} onChangeText={setLanguage} />
          <View style={styles.actions}>
            <TouchableOpacity style={styles.button} onPress={loadModelStatuses} disabled={busy}>
              <Text style={styles.buttonText}>Models</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.button}
              onPress={downloadSelectedModel}
              disabled={busy || !selectedModelStatus?.downloadable || selectedModelStatus.cached}
            >
              <Text style={styles.buttonText}>Download</Text>
            </TouchableOpacity>
          </View>
        </Panel>

        <Panel title="Recording">
          <View style={styles.statusRow}>
            <Text style={styles.status}>{status}</Text>
            {isUploading && <ActivityIndicator />}
          </View>
          <View style={styles.toggleRow}>
            <Text style={styles.label}>Only I speak</Text>
            <Switch
              value={soloSpeaker}
              onValueChange={(declared) => {
                setSoloSpeaker(declared);
                if (declared) {
                  setOthersRecorded(false);
                  setOthersAgreed(false);
                }
              }}
              disabled={busy}
              accessibilityLabel="Only I speak"
            />
          </View>
          <View style={styles.toggleRow}>
            <Text style={styles.label}>Recording other people</Text>
            <Switch
              value={othersRecorded}
              onValueChange={(declared) => {
                setOthersRecorded(declared);
                setOthersAgreed(false);
                if (declared) setSoloSpeaker(false);
              }}
              disabled={busy}
              accessibilityLabel="Recording other people"
            />
          </View>
          {othersRecorded && (
            <View style={styles.toggleRow}>
              <Text style={[styles.label, styles.toggleText]}>{OTHER_PARTICIPANTS_STATEMENT}</Text>
              <Switch
                value={othersAgreed}
                onValueChange={setOthersAgreed}
                disabled={busy}
                accessibilityLabel={OTHER_PARTICIPANTS_STATEMENT}
              />
            </View>
          )}
          <TouchableOpacity
            style={recorderState.isRecording ? styles.stopButton : styles.primaryButton}
            onPress={recorderState.isRecording ? stopRecording : startRecording}
            disabled={
              isUploading ||
              permissionGranted === false ||
              (!recorderState.isRecording &&
                (destination.kind !== "server" ||
                  !canStartWithParticipants({ othersRecorded, othersAgreed })))
            }
          >
            <Text style={styles.primaryButtonText}>
              {recorderState.isRecording ? "Stop" : "Record"}
            </Text>
          </TouchableOpacity>
          {busy && (
            <TouchableOpacity style={styles.button} onPress={cancelRecording}>
              <Text style={styles.buttonText}>Cancel</Text>
            </TouchableOpacity>
          )}
          {destination.kind !== "server" && (
            <Text style={styles.detail}>
              Recording needs a transcription server: the mobile app has no on-device transcription
              yet. Enter a local companion URL or consent to a remote server.
            </Text>
          )}
          {!!lastRecordingUri && <Text style={styles.detail}>{lastRecordingUri}</Text>}
          {lastParticipants && (
            <Text style={styles.detail}>
              {describeParticipants(lastParticipants.confirmedAt, (iso) =>
                new Date(iso).toLocaleString(),
              )}
            </Text>
          )}
          <Text style={styles.transcript}>{transcript || "Transcript will appear here."}</Text>
        </Panel>

        <Panel title="Metrics">
          {report ? (
            <View style={styles.metrics}>
              {mobileMetricRows(report).map((row) => (
                <Metric key={row.label} label={row.label} value={row.value} />
              ))}
              {qualityMessage && (
                <Text
                  style={
                    report.captureQuality?.state === "unknown"
                      ? styles.qualityWarning
                      : styles.detail
                  }
                  accessibilityRole="summary"
                  accessibilityLabel="Capture quality"
                >
                  {qualityMessage}
                </Text>
              )}
            </View>
          ) : (
            <Text style={styles.detail}>No analysis yet.</Text>
          )}
        </Panel>
      </ScrollView>
    </SafeAreaView>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Field({
  label,
  value,
  onChangeText,
  secureTextEntry,
  editable,
}: {
  label: string;
  value: string;
  onChangeText(value: string): void;
  secureTextEntry?: boolean;
  editable?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secureTextEntry}
        editable={editable}
        style={styles.input}
      />
    </View>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: "#f6f7f4",
  },
  content: {
    gap: 14,
    padding: 18,
  },
  header: {
    gap: 4,
  },
  eyebrow: {
    color: "#5d6b64",
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  title: {
    color: "#15201a",
    fontSize: 34,
    fontWeight: "800",
  },
  panel: {
    backgroundColor: "#ffffff",
    borderColor: "#d9e1dc",
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
    padding: 14,
  },
  panelTitle: {
    color: "#15201a",
    fontSize: 17,
    fontWeight: "800",
  },
  field: {
    gap: 6,
  },
  label: {
    color: "#15201a",
    fontSize: 13,
    fontWeight: "700",
  },
  input: {
    borderColor: "#c9d4ce",
    borderRadius: 8,
    borderWidth: 1,
    color: "#15201a",
    minHeight: 44,
    paddingHorizontal: 12,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
  },
  button: {
    alignItems: "center",
    borderColor: "#c9d4ce",
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    justifyContent: "center",
    minHeight: 44,
  },
  buttonText: {
    color: "#15201a",
    fontWeight: "700",
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#196d5c",
    borderRadius: 8,
    justifyContent: "center",
    minHeight: 48,
  },
  stopButton: {
    alignItems: "center",
    backgroundColor: "#8b2f34",
    borderRadius: 8,
    justifyContent: "center",
    minHeight: 48,
  },
  primaryButtonText: {
    color: "#ffffff",
    fontWeight: "800",
  },
  toggleRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  toggleText: {
    flexShrink: 1,
    marginRight: 12,
  },
  qualityWarning: {
    backgroundColor: "#fbf3e8",
    borderColor: "#e3c9a8",
    borderRadius: 8,
    borderWidth: 1,
    color: "#7a4a12",
    fontSize: 13,
    padding: 12,
  },
  statusRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  status: {
    color: "#15201a",
    flex: 1,
    fontSize: 16,
    fontWeight: "700",
  },
  detail: {
    color: "#66746c",
    fontSize: 13,
  },
  transcript: {
    color: "#15201a",
    fontSize: 16,
    lineHeight: 23,
  },
  metrics: {
    gap: 10,
  },
  metric: {
    borderColor: "#d9e1dc",
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
  },
  metricLabel: {
    color: "#66746c",
    fontSize: 13,
  },
  metricValue: {
    color: "#15201a",
    fontSize: 24,
    fontWeight: "800",
    textTransform: "capitalize",
  },
});
