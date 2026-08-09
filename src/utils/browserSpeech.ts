export interface BrowserSpeechTranscriber {
  pause: () => void;
  resume: () => void;
  stop: () => void;
}

interface BrowserSpeechOptions {
  language: string;
  onTranscript: (text: string, language: string) => void;
  onError: (message: string) => void;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string; message?: string }) => void) | null;
  onresult: ((event: {
    resultIndex: number;
    results: ArrayLike<{
      isFinal: boolean;
      0: { transcript: string };
    }>;
  }) => void) | null;
  start: (audioTrack?: MediaStreamTrack) => void;
  abort: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  const speechWindow = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };

  return speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition || null;
}

/**
 * Starts browser speech recognition using the captured tab/microphone audio track.
 * Returns null when the browser does not expose the track-based Web Speech API.
 */
export function startBrowserSpeechTranscription(
  audioTrack: MediaStreamTrack,
  options: BrowserSpeechOptions
): BrowserSpeechTranscriber | null {
  const SpeechRecognition = getSpeechRecognitionConstructor();
  if (!SpeechRecognition || audioTrack.kind !== "audio" || audioTrack.readyState !== "live") {
    return null;
  }

  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = options.language;

  let active = true;
  let paused = false;
  let running = false;
  let restartTimer: number | null = null;

  const scheduleRestart = () => {
    if (!active || paused || audioTrack.readyState !== "live" || restartTimer !== null) return;

    restartTimer = window.setTimeout(() => {
      restartTimer = null;
      if (!active || paused || running || audioTrack.readyState !== "live") return;

      try {
        recognition.start(audioTrack);
      } catch (error: any) {
        active = false;
        options.onError(error?.message || "El navegador no pudo reiniciar el reconocimiento de voz.");
      }
    }, 250);
  };

  recognition.onstart = () => {
    running = true;
  };

  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index++) {
      const result = event.results[index];
      const transcript = result?.[0]?.transcript?.trim();
      if (result?.isFinal && transcript) {
        options.onTranscript(transcript, recognition.lang);
      }
    }
  };

  recognition.onerror = (event) => {
    if (event.error === "aborted" || event.error === "no-speech") return;
    active = false;
    options.onError(event.message || `Error de reconocimiento de voz: ${event.error || "desconocido"}`);
  };

  recognition.onend = () => {
    running = false;
    scheduleRestart();
  };

  try {
    recognition.start(audioTrack);
  } catch {
    return null;
  }

  return {
    pause: () => {
      paused = true;
      try {
        recognition.abort();
      } catch {}
    },
    resume: () => {
      paused = false;
      if (!running) scheduleRestart();
    },
    stop: () => {
      active = false;
      paused = true;
      if (restartTimer !== null) window.clearTimeout(restartTimer);
      try {
        recognition.abort();
      } catch {}
    },
  };
}
