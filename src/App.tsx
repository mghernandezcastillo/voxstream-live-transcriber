import React, { useState, useRef, useEffect } from "react";
import {
  TranscriptSegment,
  TranscriptionState,
  AudioSourceType,
  AISummary,
  Settings,
} from "./types";
import { formatTimestamp, blobToBase64, getSupportedAudioMimeType } from "./utils/audioUtils";
import { AudioVisualizer } from "./components/AudioVisualizer";
import { TabShareGuideModal } from "./components/TabShareGuideModal";
import { LiveTranscriptStream } from "./components/LiveTranscriptStream";
import { AISummaryPanel } from "./components/AISummaryPanel";
import { AIChatModal } from "./components/AIChatModal";
import { SettingsModal } from "./components/SettingsModal";
import { ExportModal } from "./components/ExportModal";
import { FastScreenHelperModal } from "./components/FastScreenHelperModal";
import {
  Monitor,
  Mic,
  Pause,
  Play,
  Square,
  Sparkles,
  MessageSquare,
  Download,
  Settings as SettingsIcon,
  HelpCircle,
  AlertTriangle,
  Volume2,
  Tv,
  Zap,
} from "lucide-react";

export default function App() {
  // State
  const [transcriptionState, setTranscriptionState] = useState<TranscriptionState>("idle");
  const [sourceType, setSourceType] = useState<AudioSourceType>("tab");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [summary, setSummary] = useState<AISummary | null>(null);
  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
  const [isProcessingChunk, setIsProcessingChunk] = useState(false);
  const [recordingDurationMs, setRecordingDurationMs] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Modals
  const [showGuideModal, setShowGuideModal] = useState(false);
  const [showChatModal, setShowChatModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showFastHelperModal, setShowFastHelperModal] = useState(false);

  // Settings
  const [settings, setSettings] = useState<Settings>({
    chunkDurationSec: 3.5,
    autoTranslate: false,
    targetLanguage: "Inglés",
    autoScroll: true,
    fontSize: "md",
    showTimestamps: true,
    showSpeakers: false,
    showVideoPreview: true,
  });

  // Refs for audio processing
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const isRecordingRef = useRef<boolean>(false);
  const timerRef = useRef<number | null>(null);
  const chunkIntervalRef = useRef<number | null>(null);
  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);
  const startTimeRef = useRef<number>(0);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopTranscription();
    };
  }, []);

  // Update video element preview when stream changes
  useEffect(() => {
    if (videoPreviewRef.current && stream) {
      videoPreviewRef.current.srcObject = stream;
    }
  }, [stream]);

  // Duration Timer
  useEffect(() => {
    if (transcriptionState === "recording") {
      timerRef.current = window.setInterval(() => {
        setRecordingDurationMs((prev) => prev + 1000);
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [transcriptionState]);

  // Start Tab Audio Capture
  const handleStartTabCapture = async () => {
    setErrorMessage(null);
    setSourceType("tab");

    try {
      setTranscriptionState("requesting");

      // Request screen/tab sharing with audio enabled (Chrome defaults audio on for tabs)
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: "browser",
        },
        audio: {
          suppressLocalAudioPlayback: false,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        } as any,
        systemAudio: "include",
        surfaceSwitching: "include",
      } as any);

      const audioTracks = displayStream.getAudioTracks();

      if (audioTracks.length === 0) {
        setErrorMessage(
          "⚠️ No se detectó canal de audio en la pestaña seleccionada. Al abrir el selector de Chrome, asegúrate de marcar la casilla 'Compartir audio de la pestaña' en la esquina inferior izquierda."
        );
        // Stop video track
        displayStream.getTracks().forEach((track) => track.stop());
        setTranscriptionState("idle");
        return;
      }

      // Handle when user stops sharing via browser banner ("Stop sharing")
      displayStream.getVideoTracks()[0]?.addEventListener("ended", () => {
        stopTranscription();
      });

      setStream(displayStream);
      startAudioRecorder(displayStream);
    } catch (err: any) {
      console.error("Error capturing tab audio:", err);
      if (
        err.message?.includes("display-capture") ||
        err.message?.includes("permissions policy") ||
        err.name === "SecurityError"
      ) {
        setErrorMessage(
          "⚠️ La captura de pantalla está restringida dentro del marco incrustado del navegador. Por favor abre la app en una nueva pestaña (botón superior derecho 'Open in new tab') para habilitar la transmisión en vivo de pestañas."
        );
      } else if (err.name !== "NotAllowedError") {
        setErrorMessage(`Error al capturar pestaña: ${err.message || "Permiso denegado"}`);
      }
      setTranscriptionState("idle");
    }
  };

  // Start Microphone Audio Capture
  const handleStartMicCapture = async () => {
    setErrorMessage(null);
    setSourceType("mic");

    try {
      setTranscriptionState("requesting");
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      setStream(micStream);
      startAudioRecorder(micStream);
    } catch (err: any) {
      console.error("Error capturing mic audio:", err);
      setErrorMessage(`Error al acceder al micrófono: ${err.message || "Permiso denegado"}`);
      setTranscriptionState("idle");
    }
  };

  // Setup MediaRecorder and slice chunks
  const startAudioRecorder = async (mediaStream: MediaStream) => {
    try {
      const audioTracks = mediaStream.getAudioTracks();
      if (audioTracks.length === 0) {
        setErrorMessage(
          "⚠️ No se detectó canal de audio. Al compartir la pestaña, asegúrate de marcar la casilla 'Compartir audio de la pestaña'."
        );
        setTranscriptionState("idle");
        return;
      }

      // Cleanup any active AudioContext
      if (audioContextRef.current) {
        try {
          audioContextRef.current.close();
        } catch {}
        audioContextRef.current = null;
      }

      let recordingStream: MediaStream;

      // Normalize stream via AudioContext to ensure 100% MediaRecorder compatibility across YouTube / exams / live tabs
      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          if (ctx.state === "suspended") {
            await ctx.resume();
          }
          const source = ctx.createMediaStreamSource(mediaStream);
          const dest = ctx.createMediaStreamDestination();
          source.connect(dest);
          audioContextRef.current = ctx;
          recordingStream = dest.stream;
        } else {
          recordingStream = new MediaStream(audioTracks);
        }
      } catch (audioCtxErr) {
        console.warn("AudioContext normalization failed, using raw audio tracks:", audioCtxErr);
        recordingStream = new MediaStream(audioTracks);
      }

      const mimeType = getSupportedAudioMimeType();
      let mediaRecorder: MediaRecorder;
      try {
        mediaRecorder = mimeType
          ? new MediaRecorder(recordingStream, { mimeType })
          : new MediaRecorder(recordingStream);
      } catch (e) {
        console.warn("MediaRecorder creation with mimeType failed, falling back to default:", e);
        mediaRecorder = new MediaRecorder(recordingStream);
      }

      recorderRef.current = mediaRecorder;
      isRecordingRef.current = true;
      startTimeRef.current = Date.now();

      const effectiveMimeType = mediaRecorder.mimeType || mimeType || "audio/webm";

      mediaRecorder.ondataavailable = async (e) => {
        if (e.data && e.data.size > 1000) {
          await processAudioChunk(e.data, effectiveMimeType);
        }
      };

      mediaRecorder.onstop = () => {
        // Restart recording next chunk if still actively transcribing
        if (isRecordingRef.current && recorderRef.current && recorderRef.current.state === "inactive") {
          try {
            recorderRef.current.start();
          } catch (err) {
            console.warn("Error restarting MediaRecorder for next chunk:", err);
          }
        }
      };

      mediaRecorder.start(); // Start recording chunk 1
      setTranscriptionState("recording");

      // Periodically stop & restart MediaRecorder so every chunk is a 100% standalone valid WebM file with EBML header
      const intervalMs = settings.chunkDurationSec * 1000;
      chunkIntervalRef.current = window.setInterval(() => {
        if (isRecordingRef.current && recorderRef.current && recorderRef.current.state === "recording") {
          recorderRef.current.stop(); // Triggers ondataavailable with complete header + onstop restarts
        }
      }, intervalMs);
    } catch (err: any) {
      console.error("Failed to start MediaRecorder:", err);
      setErrorMessage(`No se pudo iniciar el grabador de audio: ${err.message || "Error del navegador"}`);
      setTranscriptionState("idle");
    }
  };

  // Send chunk to Gemini backend API
  const processAudioChunk = async (audioBlob: Blob, mimeType: string) => {
    setIsProcessingChunk(true);

    try {
      console.log(`[VoxStream Audio] Capturado chunk de audio: ${audioBlob.size} bytes (${mimeType})`);
      const base64Audio = await blobToBase64(audioBlob);

      // Extract previous context string from latest segments
      const previousContext = segments
        .slice(-3)
        .map((s) => s.text)
        .join(" ");

      const res = await fetch("/api/transcribe-chunk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64: base64Audio,
          mimeType,
          previousContext,
          targetLanguage: settings.autoTranslate ? settings.targetLanguage : "auto",
        }),
      });

      if (!res.ok) {
        const errorJson = await res.json().catch(() => ({}));
        throw new Error(errorJson.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      console.log(`[VoxStream API] Respuesta servidor:`, data);

      if (data.transcript && data.transcript.trim()) {
        const text = data.transcript.trim();
        console.log(`[VoxStream Transcripción] Nuevo texto detectado: "${text}"`);
        const currentMs = Date.now() - startTimeRef.current;
        const formattedTime = formatTimestamp(currentMs);

        let translatedText = "";
        if (settings.autoTranslate) {
          try {
            const transRes = await fetch("/api/translate-transcript", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                text,
                targetLanguage: settings.targetLanguage,
              }),
            });
            const transData = await transRes.json();
            translatedText = transData.translatedText || "";
          } catch (tErr) {
            console.error("Translation error:", tErr);
          }
        }

        const newSegment: TranscriptSegment = {
          id: `${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
          timestamp: formattedTime,
          rawTimestampMs: currentMs,
          text,
          translatedText: translatedText || undefined,
          speaker: data.speaker || undefined,
          language: data.detectedLanguage || undefined,
        };

        setSegments((prev) => [...prev, newSegment]);
      }
    } catch (err: any) {
      console.error("Error processing chunk:", err);
    } finally {
      setIsProcessingChunk(false);
    }
  };

  // Pause / Resume
  const togglePause = () => {
    if (!recorderRef.current) return;

    if (transcriptionState === "recording") {
      recorderRef.current.pause();
      setTranscriptionState("paused");
    } else if (transcriptionState === "paused") {
      recorderRef.current.resume();
      setTranscriptionState("recording");
    }
  };

  // Stop Transcription
  const stopTranscription = () => {
    isRecordingRef.current = false;
    if (chunkIntervalRef.current) clearInterval(chunkIntervalRef.current);
    if (timerRef.current) clearInterval(timerRef.current);

    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }

    if (audioContextRef.current) {
      try {
        audioContextRef.current.close();
      } catch {}
      audioContextRef.current = null;
    }

    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }

    setStream(null);
    setTranscriptionState("idle");
  };

  // Generate AI Summary
  const handleGenerateSummary = async () => {
    if (segments.length === 0) return;
    setIsGeneratingSummary(true);

    const fullTranscriptText = segments.map((s) => `[${s.timestamp}] ${s.text}`).join("\n");

    try {
      const res = await fetch("/api/summarize-transcript", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullTranscript: fullTranscriptText }),
      });

      const data = await res.json();
      setSummary({
        summary: data.summary || "No se obtuvo resumen.",
        keyPoints: data.keyPoints || [],
        topics: data.topics || [],
        actionItems: data.actionItems || [],
        updatedAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      });
    } catch (err) {
      console.error("Error generating summary:", err);
    } finally {
      setIsGeneratingSummary(false);
    }
  };

  // Segment Handlers
  const handleUpdateSegment = (id: string, newText: string) => {
    setSegments((prev) => prev.map((s) => (s.id === id ? { ...s, text: newText } : s)));
  };

  const handleDeleteSegment = (id: string) => {
    setSegments((prev) => prev.filter((s) => s.id !== id));
  };

  const handleClearAll = () => {
    if (window.confirm("¿Seguro que deseas borrar toda la transcripción actual?")) {
      setSegments([]);
      setSummary(null);
      setRecordingDurationMs(0);
    }
  };

  return (
    <div className="min-h-screen bg-[#020617] text-slate-100 flex flex-col font-sans selection:bg-cyan-500 selection:text-slate-950 antialiased relative overflow-x-hidden">
      {/* Background Mesh Blur Gradients */}
      <div className="fixed top-[-10%] left-[-10%] w-[45%] h-[45%] bg-indigo-600/25 rounded-full blur-[130px] pointer-events-none" />
      <div className="fixed bottom-[-5%] right-[-5%] w-[50%] h-[50%] bg-fuchsia-600/15 rounded-full blur-[140px] pointer-events-none" />
      <div className="fixed top-1/3 right-1/4 w-[35%] h-[35%] bg-cyan-500/15 rounded-full blur-[110px] pointer-events-none" />

      {/* Top Header Bar */}
      <header className="sticky top-0 z-30 bg-white/5 backdrop-blur-xl border-b border-white/10 px-4 lg:px-8 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-500 to-cyan-400 p-0.5 shadow-lg shadow-indigo-500/20">
            <div className="w-full h-full bg-[#020617]/80 backdrop-blur-md rounded-[10px] flex items-center justify-center text-cyan-400">
              <Volume2 size={22} />
            </div>
          </div>
          <div>
            <h1 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
              VoxStream <span className="text-cyan-400">AI</span>
              <span className="text-[10px] bg-cyan-400/10 text-cyan-300 border border-cyan-400/20 px-2 py-0.5 rounded-full font-mono uppercase tracking-wider font-semibold">
                Frosted Audio
              </span>
            </h1>
            <p className="text-xs text-slate-400 hidden sm:block">
              Transcripción en vivo y análisis inteligente de audio de pestaña con Gemini
            </p>
          </div>
        </div>

        {/* Global Toolbar Action Buttons */}
        <div className="flex items-center gap-2">
          {/* Fast Screen Helper / Exam Assistant */}
          <button
            onClick={() => setShowFastHelperModal(true)}
            className="px-3.5 py-2 bg-gradient-to-r from-cyan-500/20 to-indigo-500/20 hover:from-cyan-500/30 hover:to-indigo-500/30 text-cyan-300 rounded-xl text-xs font-bold flex items-center gap-1.5 transition border border-cyan-400/40 shadow-lg shadow-cyan-500/10 active:scale-95 backdrop-blur-md"
            title="Ayudante de Exámenes y Consultas Rápidas de Pantalla (Bajo Consumo Tokens)"
          >
            <Zap size={15} className="text-cyan-400 fill-cyan-400/30" />
            <span className="hidden sm:inline">⚡ Ayuda Exámenes</span>
          </button>

          {/* Help / Guide */}
          <button
            onClick={() => setShowGuideModal(true)}
            className="px-3 py-2 bg-white/5 hover:bg-white/10 text-slate-300 rounded-xl text-xs font-medium flex items-center gap-1.5 transition border border-white/10 backdrop-blur-md"
            title="Ver guía para compartir audio"
          >
            <HelpCircle size={16} className="text-cyan-400" />
            <span className="hidden md:inline">¿Cómo funciona?</span>
          </button>

          {/* AI Chat Button */}
          <button
            onClick={() => setShowChatModal(true)}
            className="px-3 py-2 bg-white/5 hover:bg-white/10 text-cyan-300 rounded-xl text-xs font-medium flex items-center gap-1.5 transition border border-cyan-400/30 hover:border-cyan-400/60 backdrop-blur-md"
            title="Preguntar a la IA sobre la transcripción"
          >
            <MessageSquare size={16} className="text-cyan-400" />
            <span className="hidden md:inline">Consultar IA</span>
          </button>

          {/* Settings Button */}
          <button
            onClick={() => setShowSettingsModal(true)}
            className="p-2 bg-white/5 hover:bg-white/10 text-slate-300 rounded-xl text-xs font-medium transition border border-white/10 backdrop-blur-md"
            title="Configuración"
          >
            <SettingsIcon size={16} />
          </button>

          {/* Export Button */}
          <button
            onClick={() => setShowExportModal(true)}
            disabled={segments.length === 0}
            className="px-3.5 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 disabled:opacity-40 rounded-xl text-xs font-bold flex items-center gap-1.5 transition shadow-lg shadow-cyan-500/20 active:scale-95"
          >
            <Download size={15} />
            <span className="hidden sm:inline">Exportar</span>
          </button>
        </div>
      </header>

      {/* Main App Canvas Layout */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 space-y-6 z-10">
        {/* Error Notification Banner */}
        {errorMessage && (
          <div className="p-4 bg-amber-950/60 backdrop-blur-xl border border-amber-500/40 rounded-2xl flex items-start justify-between gap-3 text-amber-200 text-xs shadow-2xl animate-in fade-in">
            <div className="flex items-start gap-2.5">
              <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" />
              <div className="space-y-2">
                <p className="leading-relaxed font-medium">{errorMessage}</p>
                {errorMessage.includes("pestaña nueva") && (
                  <button
                    onClick={() => window.open(window.location.href, "_blank")}
                    className="px-3 py-1 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold rounded-lg text-xs transition inline-flex items-center gap-1 shadow-md"
                  >
                    🚀 Abrir en Pestaña Nueva para Permitir Transmisión
                  </button>
                )}
              </div>
            </div>
            <button
              onClick={() => setErrorMessage(null)}
              className="text-amber-400 hover:text-white text-xs font-bold underline shrink-0"
            >
              Cerrar
            </button>
          </div>
        )}

        {/* Primary Controls Bar */}
        <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-4 sm:p-5 shadow-2xl flex flex-col md:flex-row items-center justify-between gap-4">
          {/* Main Action Buttons */}
          <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
            {transcriptionState === "idle" ? (
              <>
                <button
                  onClick={() => setShowGuideModal(true)}
                  className="flex-1 sm:flex-initial px-5 py-3 bg-gradient-to-r from-indigo-500 via-purple-500 to-cyan-500 hover:opacity-95 text-white rounded-xl font-bold text-sm shadow-xl shadow-cyan-500/20 flex items-center justify-center gap-2.5 transition transform active:scale-98"
                >
                  <Monitor size={18} />
                  <span>Compartir Pestaña (Pantalla y Audio)</span>
                </button>

                <button
                  onClick={handleStartMicCapture}
                  className="px-4 py-3 bg-white/5 hover:bg-white/10 text-slate-200 rounded-xl font-semibold text-sm border border-white/10 flex items-center justify-center gap-2 transition backdrop-blur-md"
                >
                  <Mic size={18} className="text-cyan-400" />
                  <span>Usar Micrófono</span>
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={togglePause}
                  className="px-4 py-2.5 bg-white/5 hover:bg-white/10 text-slate-200 rounded-xl font-semibold text-xs border border-white/10 flex items-center gap-2 transition backdrop-blur-md"
                >
                  {transcriptionState === "recording" ? (
                    <>
                      <Pause size={16} className="text-amber-400" />
                      <span>Pausar</span>
                    </>
                  ) : (
                    <>
                      <Play size={16} className="text-emerald-400" />
                      <span>Reanudar</span>
                    </>
                  )}
                </button>

                <button
                  onClick={stopTranscription}
                  className="px-5 py-2.5 bg-rose-500/80 hover:bg-rose-500 text-white rounded-xl font-bold text-xs shadow-lg border border-rose-400/30 flex items-center gap-2 transition active:scale-98 backdrop-blur-md"
                >
                  <Square size={16} />
                  <span>Detener Captura</span>
                </button>
              </>
            )}
          </div>

          {/* Recording Timer & Status Indicators */}
          <div className="flex items-center gap-4 text-xs font-mono w-full md:w-auto justify-between md:justify-end border-t md:border-t-0 pt-3 md:pt-0 border-white/10">
            <div className="flex items-center gap-2 bg-slate-950/60 px-3 py-1.5 rounded-xl border border-white/10 backdrop-blur-md">
              <span className="text-slate-400">Tiempo:</span>
              <span className="font-bold text-cyan-300 text-sm">
                {formatTimestamp(recordingDurationMs)}
              </span>
            </div>

            <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white/5 border border-white/10 backdrop-blur-md">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  transcriptionState === "recording"
                    ? "bg-cyan-400 animate-pulse shadow-[0_0_10px_rgba(34,211,238,0.8)]"
                    : transcriptionState === "paused"
                    ? "bg-amber-400"
                    : "bg-slate-500"
                }`}
              />
              <span className="capitalize font-sans font-semibold text-slate-200">
                {transcriptionState === "recording"
                  ? "Transmitiendo"
                  : transcriptionState === "paused"
                  ? "En Pausa"
                  : transcriptionState === "requesting"
                  ? "Conectando..."
                  : "Listo"}
              </span>
            </div>
          </div>
        </div>

        {/* Audio Visualizer Bar */}
        <AudioVisualizer
          stream={stream}
          isRecording={transcriptionState === "recording"}
          sourceType={sourceType}
        />

        {/* Split Grid: Left Live Stream, Right AI Insights & Video Thumbnail */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Transcript Stream Column (2 cols) */}
          <div className="lg:col-span-2 flex flex-col min-h-[500px]">
            <LiveTranscriptStream
              segments={segments}
              settings={settings}
              onUpdateSegment={handleUpdateSegment}
              onDeleteSegment={handleDeleteSegment}
              onClearAll={handleClearAll}
              isRecording={transcriptionState === "recording"}
              isProcessingChunk={isProcessingChunk}
            />
          </div>

          {/* Right Sidebar Column (1 col): Video Preview + AI Summary */}
          <div className="space-y-6 flex flex-col">
            {/* Tab Video Preview Box (if capturing display stream) */}
            {stream && sourceType === "tab" && settings.showVideoPreview && (
              <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-4 shadow-2xl space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                    <Tv size={14} className="text-cyan-400" />
                    <span>Vista Previa de Pestaña</span>
                  </span>
                  <span className="text-[10px] bg-cyan-400/10 text-cyan-300 border border-cyan-400/20 px-2 py-0.5 rounded-full font-mono font-semibold">
                    En Vivo
                  </span>
                </div>

                <div className="relative aspect-video bg-slate-950/80 rounded-xl overflow-hidden border border-white/10 shadow-inner group">
                  <video
                    ref={videoPreviewRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full h-full object-contain"
                  />
                  <button
                    onClick={() => setShowFastHelperModal(true)}
                    className="absolute bottom-3 right-3 px-3 py-1.5 bg-cyan-500/90 hover:bg-cyan-400 text-slate-950 text-xs font-bold rounded-lg shadow-xl backdrop-blur-md flex items-center gap-1.5 transition active:scale-95"
                  >
                    <Zap size={14} />
                    <span>⚡ Captura Rápida AI</span>
                  </button>
                </div>
              </div>
            )}

            {/* AI Summary Panel */}
            <div className="flex-1">
              <AISummaryPanel
                segments={segments}
                summary={summary}
                isGenerating={isGeneratingSummary}
                onGenerateSummary={handleGenerateSummary}
              />
            </div>
          </div>
        </div>
      </main>

      {/* Modals */}
      <TabShareGuideModal
        isOpen={showGuideModal}
        onClose={() => setShowGuideModal(false)}
        onConfirmStart={handleStartTabCapture}
      />

      <AIChatModal
        isOpen={showChatModal}
        onClose={() => setShowChatModal(false)}
        segments={segments}
        videoRef={videoPreviewRef}
        stream={stream}
      />

      <SettingsModal
        isOpen={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
        settings={settings}
        onUpdateSettings={(newSet) => setSettings((prev) => ({ ...prev, ...newSet }))}
      />

      <ExportModal
        isOpen={showExportModal}
        onClose={() => setShowExportModal(false)}
        segments={segments}
      />

      <FastScreenHelperModal
        isOpen={showFastHelperModal}
        onClose={() => setShowFastHelperModal(false)}
        videoRef={videoPreviewRef}
        stream={stream}
      />
    </div>
  );
}
