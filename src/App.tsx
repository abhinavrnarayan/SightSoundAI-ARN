import { useState, useRef, useCallback, useEffect } from "react";
import Webcam from "react-webcam";
import {
  trackEvent,
  updateUserProperties,
  trackEngagement,
  trackPerformance,
  trackError,
  getSessionInfo,
  trackVoiceCommand,
  trackMicrophonePermission,
  trackSpeechSupport,
  trackCameraError,
  trackTabVisibility,
} from "./firebase";
import {
  Camera,
  Volume2,
  StopCircle,
  Eye,
  FileText,
  AlertTriangle,
  Mic,
  Navigation2,
  Languages,
} from "lucide-react";
import SpeechRecognition, {
  useSpeechRecognition,
} from "react-speech-recognition";
import {
  analyzeImage,
  analyzeForNavigation,
  askAboutScene,
  ConversationTurn,
} from "./services/vision";
import { matchVoiceCommand, VoiceCommandId } from "./voice/commandRouter";
import { VoiceSettings } from "./components/VoiceSettings";
import { Tab } from "./components/Tab";
import { translations, Language } from "./translations";

function App() {
  const [isCapturing, setIsCapturing] = useState(false);
  const [isStarted, setIsStarted] = useState(false);
  const [analysis, setAnalysis] = useState<{
    objects: string[];
    description: string;
    hazards: string[];
    navigation?: string;
  } | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [mode, setMode] = useState<"scene" | "navigation">("scene");
  const [language, setLanguage] = useState<Language>("en");
  const [conversation, setConversation] = useState<ConversationTurn | null>(null);
  const [isThinking, setIsThinking] = useState(false);
  const webcamRef = useRef<Webcam>(null);
  const speechRef = useRef<SpeechSynthesisUtterance | null>(null);
  const analysisIntervalRef = useRef<number | null>(null);

  // Live values for the callbacks that run outside the React render cycle.
  // A callback that reads a state value from its closure keeps the value from
  // the render that created it, which freezes the mode and the language.
  const isPausedRef = useRef<boolean>(false);
  const isSpeakingRef = useRef<boolean>(false);
  const isCapturingRef = useRef<boolean>(false);
  const modeRef = useRef<"scene" | "navigation">("scene");
  const languageRef = useRef<Language>("en");
  const isThinkingRef = useRef<boolean>(false); // one question at a time

  const conversationHistoryRef = useRef<ConversationTurn[]>([]);
  // One question runs at a time. A question spoken during that time waits.
  const queuedQuestionRef = useRef<string | null>(null);
  const questionAfterSpeechRef = useRef<string | null>(null);
  const lastUtteranceRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const imageAnalysisCountRef = useRef<number>(0);
  const totalSpeakingTimeRef = useRef<number>(0);
  const speakingStartTimeRef = useRef<number | null>(null);
  const lastInteractionTimeRef = useRef<number>(Date.now());
  const lastCaptureTimeRef = useRef<number>(0);
  const CAPTURE_COOLDOWN_MS = 3000; // Minimum gap between auto-captures (reduced for lower latency)
  const startButtonRef = useRef<HTMLButtonElement>(null);
  const preloadedAnalysisRef = useRef<{
    objects: string[];
    description: string;
    hazards: string[];
    navigation?: string;
    mode: "scene" | "navigation";
  } | null>(null);
  const voiceCommandRef = useRef<{
    onCommand: () => void;
  } | null>(null);
  // The hazards from the previous analysis. A change means a new hazard.
  const previousHazardKeyRef = useRef<string>("");
  const welcomeSpokenRef = useRef<boolean>(false);

  // The capture callback and the speech callback call each other. The speech
  // function is reached through this ref, so the cycle never freezes.
  const speakRef = useRef<(text: string, isCommand: boolean) => void>(() => {});
  // The start and resume paths trigger a capture through this ref.
  const captureRef = useRef<() => void>(() => {});
  // The speech callback starts a waiting question through this ref.
  const questionRef = useRef<(question: string) => void>(() => {});

  const t = translations[language];

  const handleModeSwitch = (newMode: "scene" | "navigation") => {
    const previousMode = mode;
    modeRef.current = newMode;
    setMode(newMode);
    // A preloaded result belongs to the old mode. Drop it so it is not spoken.
    preloadedAnalysisRef.current = null;
    speak(t.switchedToMode(newMode), true);

    // Track mode switch in GA
    trackEvent("mode_switched", {
      from_mode: previousMode,
      to_mode: newMode,
      method: "voice_command",
      language: language,
    });
  };

  const handleLanguageToggle = () => {
    const languages: Language[] = ["en", "hi", "ml"];
    const currentIndex = languages.indexOf(language);
    const nextIndex = (currentIndex + 1) % languages.length;
    const newLang = languages[nextIndex];

    const previous = language;
    languageRef.current = newLang;
    setLanguage(newLang);
    localStorage.setItem("language", newLang);

    // Track language change in GA
    trackEvent("language_changed", {
      from_language: previous,
      to_language: newLang,
      method: "button_click",
    });

    // Update user property
    updateUserProperties({ preferred_language: newLang });
  };

  // Starts the app. The Start button and the voice command use the same path
  // so a blind user gets the same spoken feedback either way.
  const startApp = () => {
    setIsStarted(true);
    setIsPaused(false);
    isPausedRef.current = false;
    trackVoiceCommand("start", language, true);
    speak(t.startedMessage, true);
  };

  // Stops narration and analysis until the user says Start or Restart.
  const pauseApp = () => {
    setIsPaused(true);
    isPausedRef.current = true;
    // Drop any analysis prepared before the stop so it is not spoken later.
    preloadedAnalysisRef.current = null;
    // Drop a waiting question. No API call may run while the app is stopped.
    queuedQuestionRef.current = null;
    questionAfterSpeechRef.current = null;

    // Drop the old handlers first. A cancelled utterance still fires "onend",
    // and that stale callback must not resume the app.
    if (speechRef.current) {
      speechRef.current.onend = null;
      speechRef.current.onstart = null;
    }
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
    // Calculate interrupted speaking time
    let interruptedDuration = 0;
    if (speakingStartTimeRef.current) {
      interruptedDuration = Math.round(performance.now() - speakingStartTimeRef.current);
      speakingStartTimeRef.current = null;
    }

    trackEngagement("speech_stopped", {
      method: "user_action",
      language: language,
      interrupted_duration_ms: interruptedDuration,
      total_speaking_time_ms: totalSpeakingTimeRef.current,
    });

    trackVoiceCommand("stop", language, true);
    speak(t.stopMessage, true);
  };

  // Resumes analysis and narration.
  const resumeApp = () => {
    setIsPaused(false);
    isPausedRef.current = false;
    trackVoiceCommand("restart", language, true);
    // The next analysis starts now, not after the confirmation speech ends.
    captureRef.current();
    speak(t.restartMessage, true);
  };

  useEffect(() => {
    const savedLang = localStorage.getItem("language") as Language;
    if (savedLang && ["en", "ml", "hi"].includes(savedLang)) {
      languageRef.current = savedLang;
      setLanguage(savedLang);
      // Track initial language preference
      updateUserProperties({ preferred_language: savedLang });
    }

    // Track app initialization with comprehensive metrics
    const sessionInfo = getSessionInfo();
    trackEvent("app_initialized", {
      has_saved_language: !!savedLang,
      initial_language: savedLang || "en",
      browser_supports_speech: browserSupportsSpeechRecognition,
      microphone_available: isMicrophoneAvailable,
      session_id: sessionInfo.sessionId,
      device_id: sessionInfo.deviceId,
    });

    // Track speech recognition and microphone support
    trackSpeechSupport(browserSupportsSpeechRecognition, isMicrophoneAvailable);
    trackMicrophonePermission(isMicrophoneAvailable);

    // Track periodic engagement (every 30 seconds)
    const engagementInterval = setInterval(() => {
      const timeSinceLastInteraction = Date.now() - lastInteractionTimeRef.current;
      trackEngagement("periodic_check", {
        session_duration: sessionInfo.sessionDuration,
        total_analyses: imageAnalysisCountRef.current,
        total_speaking_time_ms: totalSpeakingTimeRef.current,
        time_since_last_interaction_ms: timeSinceLastInteraction,
        current_mode: mode,
        current_language: language,
        is_speaking: isSpeaking,
        is_listening: listening,
      });
    }, 30000);

    // Track session end on page unload
    const handleBeforeUnload = () => {
      const finalSessionInfo = getSessionInfo();
      trackEvent("session_end", {
        session_duration: finalSessionInfo.sessionDuration,
        total_analyses: imageAnalysisCountRef.current,
        total_speaking_time_ms: totalSpeakingTimeRef.current,
        final_mode: mode,
        final_language: language,
      });
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      clearInterval(engagementInterval);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  // Answers a spoken question about what the user sees right now.
  const handleQuestion = async (question: string) => {
    if (!isStarted || isPausedRef.current) return;
    if (isThinkingRef.current) {
      // One question runs at a time. Keep the newest question for later, so a
      // follow-up question is never lost.
      queuedQuestionRef.current = question;
      return;
    }
    isThinkingRef.current = true;
    setIsThinking(true);
    setConversation({ question, answer: "" });

    // The question takes priority over the current narration.
    if (speechRef.current) {
      speechRef.current.onend = null;
      speechRef.current.onstart = null;
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    }

    const startedAt = performance.now();
    try {
      // A fresh frame answers the question about what the user sees now.
      const imageSrc = webcamRef.current ? webcamRef.current.getScreenshot() : null;
      const answer = await askAboutScene(
        question,
        imageSrc,
        language,
        conversationHistoryRef.current,
      );
      if (isPausedRef.current) return;

      // Keep a few turns so a follow-up question understands the last answer.
      conversationHistoryRef.current = [
        ...conversationHistoryRef.current,
        { question, answer },
      ].slice(-3);
      setConversation({ question, answer });
      speak(answer, false);

      trackPerformance("question_answer", Math.round(performance.now() - startedAt));
      trackVoiceCommand("question", language, true, {
        question_length: question.length,
        answer_length: answer.length,
      });
    } catch (error) {
      console.error("Error answering question:", error);
      trackError(error instanceof Error ? error : new Error(String(error)), {
        language,
      });
      speak(t.errorAnswering, true);
    } finally {
      isThinkingRef.current = false;
      setIsThinking(false);

      // A question spoken during this one waits for the narration to end, so
      // the first answer is not cut off.
      const queued = queuedQuestionRef.current;
      queuedQuestionRef.current = null;
      if (queued && !isPausedRef.current) {
        questionAfterSpeechRef.current = queued;
      }
    }
  };

  // The speech callback reaches the question handler through this ref.
  questionRef.current = handleQuestion;

  // Runs one voice command.
  const runVoiceCommand = (command: VoiceCommandId) => {
    switch (command) {
      case "start":
        startApp();
        return;
      case "stop":
        pauseApp();
        return;
      case "restart":
        // Restart also resumes from the welcome screen.
        if (!isStarted) {
          startApp();
          return;
        }
        resumeApp();
        return;
      case "scene":
      case "navigation": {
        if (!isStarted) return;
        const newMode = command === "scene" ? "scene" : "navigation";
        // While narrating, wait for the narration to end so it is not cut off.
        if (isSpeaking) {
          voiceCommandRef.current = { onCommand: () => handleModeSwitch(newMode) };
          return;
        }
        handleModeSwitch(newMode);
        return;
      }
      case "hazards": {
        if (!isStarted || !analysis?.hazards) return;
        const response =
          analysis.hazards.length > 0
            ? t.detectedHazards(analysis.hazards)
            : t.noHazards;
        speak(response, true);

        trackVoiceCommand("hazards", language, true, {
          hazards_found: analysis.hazards.length > 0,
          hazard_count: analysis.hazards.length,
        });
        trackEngagement("voice_command", {
          command: "hazards_query",
          language: language,
          hazards_found: analysis.hazards.length > 0,
          hazard_count: analysis.hazards.length,
          mode: mode,
        });
        return;
      }
      case "describe": {
        if (!isStarted) return;
        // The current result is read again. No API call is needed.
        if (!analysis) {
          speak(t.analyzing, true);
          return;
        }
        speak(
          mode === "navigation"
            ? buildNavigationSpeech({
                hazards: analysis.hazards,
                navigation: analysis.navigation,
              })
            : buildSceneSpeech(analysis),
          true,
        );
        trackVoiceCommand("describe", language, true, { mode });
        return;
      }
      case "repeat": {
        if (!isStarted) return;
        // The last answer is read again. No API call is needed.
        if (conversation?.answer) {
          speak(conversation.answer, true);
          trackVoiceCommand("repeat", language, true, {
            source: "answer",
          });
          return;
        }
        if (!analysis) {
          speak(t.analyzing, true);
          return;
        }
        speak(
          mode === "navigation"
            ? buildNavigationSpeech({
                hazards: analysis.hazards,
                navigation: analysis.navigation,
              })
            : buildSceneSpeech(analysis),
          true,
        );
        trackVoiceCommand("repeat", language, true, { source: "scene" });
        return;
      }
      case "language":
        if (!isStarted) return;
        handleLanguageToggle();
        return;
    }
  };

  // Every utterance arrives through one command. The router decides whether it
  // is a command or a question for the assistant.
  const handleUtterance = (raw: string) => {
    const text = (raw || "").trim();
    if (!text) return;

    // The browser can send the same final result twice. Ignore the repeat.
    const now = Date.now();
    if (
      lastUtteranceRef.current.text === text &&
      now - lastUtteranceRef.current.at < 1500
    ) {
      return;
    }
    lastUtteranceRef.current = { text, at: now };

    const command = matchVoiceCommand(text);
    if (command) {
      runVoiceCommand(command);
      return;
    }
    void handleQuestion(text);
  };

  const {
    listening,
    browserSupportsSpeechRecognition,
    isMicrophoneAvailable,
  } = useSpeechRecognition({
    commands: [
      {
        // The wildcard catches every utterance, so a question can reach the
        // assistant instead of being dropped.
        command: "*",
        callback: (utterance: string) => handleUtterance(utterance),
      },
    ],
  });

  const videoConstraints = {
    facingMode: { ideal: "environment" },
    width: { ideal: window.innerWidth },
    height: { ideal: window.innerHeight },
    aspectRatio: { ideal: window.innerWidth / window.innerHeight },
  };

  // Build conversational, assistant-like speech for blind users - scene mode
  function buildSceneSpeech(result: {
    objects: string[];
    description: string;
    hazards: string[];
  }): string {
    const parts: string[] = [];

    // Start with a natural description of what's in front
    if (result.description) {
      parts.push(result.description);
    }

    // Mention key objects with their positions
    if (result.objects && result.objects.length > 0) {
      const objectList = result.objects.slice(0, 5).join(', ');
      parts.push(`I can see ${objectList}.`);
    }

    // Hazards come first if any - critical for safety
    if (result.hazards && result.hazards.length > 0) {
      const hazardList = result.hazards.join(', ');
      parts.push(`⚠️ Be careful. I detected hazards: ${hazardList}.`);
    } else {
      parts.push('No immediate hazards detected.');
    }

    return parts.join(' ');
  }

  // Build conversational, assistant-like speech for blind users - navigation mode
  function buildNavigationSpeech(result: {
    hazards: string[];
    navigation?: string;
  }): string {
    const parts: string[] = [];

    // Navigation guidance first - most important for blind users walking around
    if (result.navigation) {
      parts.push(result.navigation);
    }

    // Hazards - critical safety info
    if (result.hazards && result.hazards.length > 0) {
      const hazardList = result.hazards.join(', ');
      parts.push(`⚠️ Watch out. Hazards ahead: ${hazardList}.`);
    } else {
      parts.push('The path ahead looks clear.');
    }

    return parts.join(' ');
  }

  const handleCapture = useCallback(async () => {
    if (isPausedRef.current || isCapturingRef.current) return;

    // The camera needs a moment to start. A missing frame is not an error,
    // so the next tick tries again instead of losing the capture slot.
    const imageSrc = webcamRef.current ? webcamRef.current.getScreenshot() : null;
    if (!imageSrc) return;

    const currentMode = modeRef.current;
    const currentLanguage = languageRef.current;

    lastCaptureTimeRef.current = Date.now();
    isCapturingRef.current = true;
    setIsCapturing(true);
    const analysisStartTime = performance.now();

    try {
      imageAnalysisCountRef.current += 1;
      lastInteractionTimeRef.current = Date.now();

      // Track engagement
      trackEngagement("image_capture", {
        mode: currentMode,
        language: currentLanguage,
        analysis_count: imageAnalysisCountRef.current,
      });

      if (currentMode === "navigation") {
        const result = await analyzeForNavigation(imageSrc, currentLanguage);
        if (isPausedRef.current) return; // stopped while the request was in flight
        const analysisDuration = Math.round(performance.now() - analysisStartTime);
        const analysisResult = {
          objects: [],
          description: result.navigation || "",
          hazards: result.hazards,
          navigation: result.navigation,
          mode: "navigation" as const,
        };

        // Track navigation analysis with performance metrics
        trackEvent("image_analyzed", {
          mode: "navigation",
          language: currentLanguage,
          hazards_detected: result.hazards.length,
          hazard_types: result.hazards.join(","),
          has_navigation_guidance: !!result.navigation,
          navigation_length: result.navigation?.length || 0,
          analysis_duration_ms: analysisDuration,
          total_analyses: imageAnalysisCountRef.current,
        });

        // Track performance
        trackPerformance("navigation_analysis", analysisDuration);

        // A hazard that changes must not wait for the current narration.
        const hazardKey = result.hazards
          .map((h) => h.toLowerCase())
          .sort()
          .join(", ");
        const hazardChanged = hazardKey !== previousHazardKeyRef.current;
        previousHazardKeyRef.current = hazardKey;

        if (isSpeakingRef.current) {
          if (hazardChanged && hazardKey) {
            // A new hazard interrupts the current narration. The user must
            // hear it now, not after the current speech ends.
            preloadedAnalysisRef.current = null;
            setAnalysis({
              objects: [],
              description: result.navigation || "",
              hazards: result.hazards,
              navigation: result.navigation,
            });

            const parts = [
              `⚠️ Watch out. Hazards ahead: ${result.hazards.join(", ")}.`,
            ];
            if (result.navigation) parts.push(result.navigation);
            speakRef.current(parts.join(" "), false);

            trackEvent("hazard_interrupt", {
              hazard_types: result.hazards.join(","),
              language: currentLanguage,
            });
          } else {
            // Still narrating. Store the result for the next turn.
            preloadedAnalysisRef.current = analysisResult;
          }
        } else {
          // A fresh result replaces any stale preload so it is not spoken twice.
          preloadedAnalysisRef.current = null;
          setAnalysis({
            objects: [],
            description: result.navigation || "",
            hazards: result.hazards,
            navigation: result.navigation,
          });

          if (!isPausedRef.current) {
            speakRef.current(buildNavigationSpeech(result), false);
          }
        }
      } else {
        const result = await analyzeImage(imageSrc, currentLanguage);
        if (isPausedRef.current) return; // stopped while the request was in flight
        const analysisDuration = Math.round(performance.now() - analysisStartTime);
        const analysisResult = {
          objects: result.objects,
          description: result.description,
          hazards: result.hazards,
          navigation: undefined,
          mode: "scene" as const,
        };

        // Track scene analysis with performance metrics
        trackEvent("image_analyzed", {
          mode: "scene",
          language: currentLanguage,
          hazards_detected: result.hazards.length,
          hazard_types: result.hazards.join(","),
          objects_detected: result.objects.length,
          objects: result.objects.join(","),
          description_length: result.description.length,
          analysis_duration_ms: analysisDuration,
          total_analyses: imageAnalysisCountRef.current,
        });

        // Track performance
        trackPerformance("scene_analysis", analysisDuration);

        if (isSpeakingRef.current) {
          // Still narrating. Store the result for the next turn.
          preloadedAnalysisRef.current = analysisResult;
        } else {
          // A fresh result replaces any stale preload so it is not spoken twice.
          preloadedAnalysisRef.current = null;
          setAnalysis(result);

          if (!isPausedRef.current) {
            speakRef.current(buildSceneSpeech(result), false);
          }
        }
      }
    } catch (error) {
      const errorDuration = Math.round(performance.now() - analysisStartTime);
      console.error("Error analyzing image:", error);

      // Track error with context
      trackError(error instanceof Error ? error : new Error(String(error)), {
        mode: currentMode,
        language: currentLanguage,
        analysis_duration_ms: errorDuration,
        analysis_count: imageAnalysisCountRef.current,
      });

      speakRef.current(translations[currentLanguage].errorAnalyzing, true);
    } finally {
      isCapturingRef.current = false;
      setIsCapturing(false);
    }
  }, []);

  // The start and resume paths reach the capture callback through this ref.
  captureRef.current = handleCapture;

  // Auto-capture loop. It only runs after the user starts the app, so the
  // welcome screen never spends API calls.
  useEffect(() => {
    if (!isStarted) return;

    analysisIntervalRef.current = window.setInterval(() => {
      // Pause auto-capture when the tab is hidden (user switched away / minimized).
      if (document.visibilityState === "hidden") return;
      // While narrating, the preload started in speak.onstart prepares the next result.
      if (isPausedRef.current || isCapturingRef.current || isSpeakingRef.current) return;
      // A question is already using the camera and the API.
      if (isThinkingRef.current) return;
      // Enforce a minimum cooldown between captures to avoid hammering the API.
      if (Date.now() - lastCaptureTimeRef.current < CAPTURE_COOLDOWN_MS) return;

      handleCapture();
    }, 1000);

    return () => {
      if (analysisIntervalRef.current) {
        clearInterval(analysisIntervalRef.current);
        analysisIntervalRef.current = null;
      }
    };
  }, [handleCapture, isStarted]);

  // The first analysis must not wait for the confirmation speech to end. The
  // camera needs a moment to produce its first frame, so the capture starts
  // as soon as a frame is ready.
  useEffect(() => {
    if (!isStarted) return;

    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      if (isCapturingRef.current) {
        window.clearInterval(timer);
        return;
      }
      // getScreenshot returns null until the camera has a frame.
      const image = webcamRef.current ? webcamRef.current.getScreenshot() : null;
      if (!image) {
        // The camera has no frame yet. Keep waiting for a short time.
        if (tries > 25) window.clearInterval(timer);
        return;
      }
      window.clearInterval(timer);
      captureRef.current();
    }, 200);

    return () => window.clearInterval(timer);
  }, [isStarted]);

  // Track tab visibility changes (user switches away / back)
  useEffect(() => {
    const handleVisibilityChange = () => {
      trackTabVisibility(document.visibilityState === 'visible');
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // Chrome blocks speech until the page gets a key press or tap (error "not-allowed"),
  // so the welcome message waits for the first one. Touch only counts at pointerup/touchend.
  useEffect(() => {
    if (isStarted) return;
    const events = ["keydown", "pointerdown", "pointerup", "touchend", "click"];
    const speakOnFirstPress = (event: Event) => {
      if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
      // The Start button speaks its own confirmation, so do not talk over it.
      if (
        startButtonRef.current &&
        event.target instanceof Node &&
        startButtonRef.current.contains(event.target)
      ) {
        return;
      }
      events.forEach((name) => window.removeEventListener(name, speakOnFirstPress, true));
      if (!welcomeSpokenRef.current) {
        welcomeSpokenRef.current = true;
        speak(t.welcomeMessage, true);
      }
    };
    events.forEach((name) => window.addEventListener(name, speakOnFirstPress, true));
    return () => events.forEach((name) => window.removeEventListener(name, speakOnFirstPress, true));
    // The speech function is declared later in this component, so it cannot
    // sit in this dependency array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStarted, t.welcomeMessage]);

  // Keeps the live values in step with the state. The capture and speech
  // callbacks run outside the render cycle, so they read these refs.
  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    languageRef.current = language;
  }, [language]);

  useEffect(() => {
    isCapturingRef.current = isCapturing;
  }, [isCapturing]);

  // No cleanup. Stopping here and starting again in the next effect run (hot reload,
  // StrictMode) leaves react-speech-recognition unable to restart, so voice dies.
  useEffect(() => {
    if (browserSupportsSpeechRecognition) {
      SpeechRecognition.startListening({ continuous: true });
    }
  }, [browserSupportsSpeechRecognition]);

  const speak = useCallback((text: string, isCommand: boolean) => {
    if (speechRef.current) {
      // Drop the old handlers first. A cancelled utterance still fires "onend",
      // and that stale callback must not touch the new narration.
      speechRef.current.onend = null;
      speechRef.current.onstart = null;
      window.speechSynthesis.cancel();
    }

    const voices = window.speechSynthesis.getVoices();
    const savedVoice = localStorage.getItem("speechVoice");
    const savedRate = parseFloat(localStorage.getItem("speechRate") || "1");
    const savedPitch = parseFloat(localStorage.getItem("speechPitch") || "1");

    const voice = savedVoice
      ? voices.find((v) => v.name === savedVoice)
      : voices.find((v) => v.lang === "en-US" && v.name.includes("Google")) ||
        voices[0];

    speechRef.current = new SpeechSynthesisUtterance(text);

    if (voice) {
      speechRef.current.voice = voice;
    }
    speechRef.current.rate = savedRate;
    speechRef.current.pitch = savedPitch;

    speechRef.current.onstart = () => {
      isSpeakingRef.current = true;
      setIsSpeaking(true);
      speakingStartTimeRef.current = performance.now();

      // Start preloading the next analysis immediately when TTS starts,
      // so it's ready by the time narration finishes (zero-latency transition).
      // Command speech (stop, start, mode) must not start an analysis.
      if (!isCommand && !isPausedRef.current && webcamRef.current) {
        handleCapture();
      }

      // Track speech start
      trackEngagement("speech_started", {
        text_length: text.length,
        is_command: isCommand,
        language: languageRef.current,
      });
    };

    speechRef.current.onend = () => {
      isSpeakingRef.current = false;
      setIsSpeaking(false);

      // Calculate speaking duration
      if (speakingStartTimeRef.current) {
        const speakingDuration = Math.round(performance.now() - speakingStartTimeRef.current);
        totalSpeakingTimeRef.current += speakingDuration;

        // Track speech completion
        trackEngagement("speech_completed", {
          text_length: text.length,
          speaking_duration_ms: speakingDuration,
          total_speaking_time_ms: totalSpeakingTimeRef.current,
          is_command: isCommand,
          language: languageRef.current,
        });

        speakingStartTimeRef.current = null;
      }

      // A command spoken during narration runs now, before the next scene.
      if (voiceCommandRef.current) {
        const cmd = voiceCommandRef.current;
        voiceCommandRef.current = null;
        cmd.onCommand();
        return;
      }

      // A question that waited for this narration runs now.
      if (questionAfterSpeechRef.current) {
        const question = questionAfterSpeechRef.current;
        questionAfterSpeechRef.current = null;
        void questionRef.current(question);
        return;
      }

      // If we preloaded the next analysis while speaking, use it now for
      // zero-latency transition. A command can also end here, for example the
      // confirmation after the app starts.
      if (preloadedAnalysisRef.current && !isPausedRef.current) {
        const preloaded = preloadedAnalysisRef.current;
        preloadedAnalysisRef.current = null;

        if (preloaded.mode === "navigation") {
          setAnalysis({
            objects: [],
            description: preloaded.description,
            hazards: preloaded.hazards,
            navigation: preloaded.navigation,
          });
          speakRef.current(buildNavigationSpeech(preloaded), false);
        } else {
          setAnalysis({
            objects: preloaded.objects,
            description: preloaded.description,
            hazards: preloaded.hazards,
            navigation: undefined,
          });
          speakRef.current(buildSceneSpeech(preloaded), false);
        }
      }
    };

    window.speechSynthesis.speak(speechRef.current);
  }, [handleCapture]);

  // The capture callback calls the speech function. Keep the ref in step so
  // the callback always reaches the current speech function.
  speakRef.current = speak;

  if (!browserSupportsSpeechRecognition) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-center p-8">
          <h1 className="text-2xl font-bold mb-4">Browser Not Supported</h1>
          <p>Sorry, your browser doesn't support speech recognition.</p>
          <p className="mt-2 text-gray-400">
            Please try using Chrome, Edge, or Safari.
          </p>
        </div>
      </div>
    );
  }

  if (!isMicrophoneAvailable) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-center p-8">
          <h1 className="text-2xl font-bold mb-4">
            Microphone Access Required
          </h1>
          <p>Please allow microphone access to use voice commands.</p>
          <p className="mt-2 text-gray-400">
            You can change this in your browser settings.
          </p>
        </div>
      </div>
    );
  }

  // Welcome screen - user must start before the app begins analyzing
  if (!isStarted) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-8">
        <div className="text-center max-w-md">
          <Eye className="w-16 h-16 text-indigo-400 mb-6" />
          <h1 className="text-3xl font-bold mb-4">Welcome to SightSound AI</h1>
          <p className="text-lg text-gray-300 mb-8">
            {t.welcomeMessage}
          </p>
          <button
            ref={startButtonRef}
            onClick={startApp}
            className="w-full bg-indigo-600 hover:bg-indigo-500 text-white py-4 px-8 rounded-full text-lg font-semibold transition-colors"
          >
            Start SightSound AI
          </button>
          <p className="mt-6 text-sm text-gray-400">
            Press any key or tap the screen to hear the instructions.
          </p>
          <p className="mt-6 text-sm text-gray-400">
            Or say "Start" to begin
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900">
      <header className="fixed top-0 left-0 right-0 z-50 bg-black/30 backdrop-blur-sm text-white p-3 border-b border-white/10">
        <div className="container mx-auto flex items-center justify-between">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Eye className="w-6 h-6" />
            SightSound AI
          </h1>
          <div className="flex items-center gap-2">
            <button
              onClick={handleLanguageToggle}
              className="flex items-center gap-1.5 bg-indigo-600/20 px-3 py-1.5 rounded-full hover:bg-indigo-600/30 transition-colors text-sm"
            >
              <Languages className="w-4 h-4" />
              <span className="font-medium">{language.toUpperCase()}</span>
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={isPaused ? resumeApp : pauseApp}
                aria-label={isPaused ? "Resume" : "Stop"}
                className={`p-1.5 rounded-full transition-colors ${
                  isPaused
                    ? "bg-green-500/70 hover:bg-green-600/70"
                    : "bg-red-500/70 hover:bg-red-600/70"
                }`}
              >
                {isPaused ? (
                  <Volume2 className="w-5 h-5" />
                ) : (
                  <StopCircle className="w-5 h-5" />
                )}
              </button>
              <div
                className={`p-1.5 rounded-full transition-colors ${
                  listening ? "bg-green-500/70" : "bg-indigo-600/70"
                }`}
              >
                <Mic className="w-5 h-5" />
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="pt-16 pb-4 px-4 h-screen flex flex-col gap-4">
        <div className="relative flex-1 bg-black rounded-2xl overflow-hidden shadow-xl ring-1 ring-white/10">
          <Webcam
            ref={webcamRef}
            audio={false}
            screenshotFormat="image/jpeg"
            videoConstraints={videoConstraints}
            className="w-full h-full object-cover"
            onUserMediaError={(error) => {
              trackCameraError(error?.name || 'Unknown camera error');
            }}
          />
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-indigo-600/90 text-white px-4 py-2 rounded-full flex items-center gap-2 shadow-lg backdrop-blur-sm text-sm">
            <Camera className="w-5 h-5" />
            {isThinking
              ? t.thinking
              : isCapturing
              ? t.analyzing
              : isPaused
              ? t.listeningToCommand
              : t.autoAnalyzing}
          </div>
        </div>

        <div className="bg-gray-800/50 backdrop-blur-md rounded-2xl shadow-xl overflow-hidden ring-1 ring-white/10">
          <div className="flex border-b border-white/10">
            <Tab
              icon={<FileText className="w-4 h-4" />}
              label={t.sceneMode}
              active={mode === "scene"}
              onClick={() => {
                const previousMode = mode;
                modeRef.current = "scene";
                setMode("scene");
                trackEvent("mode_switched", {
                  from_mode: previousMode,
                  to_mode: "scene",
                  method: "button_click",
                  language: language,
                });
              }}
            />
            <Tab
              icon={<Navigation2 className="w-4 h-4" />}
              label={t.navigationMode}
              active={mode === "navigation"}
              onClick={() => {
                const previousMode = mode;
                modeRef.current = "navigation";
                setMode("navigation");
                trackEvent("mode_switched", {
                  from_mode: previousMode,
                  to_mode: "navigation",
                  method: "button_click",
                  language: language,
                });
              }}
            />
          </div>

          <div className="p-4 text-white">
            {analysis?.hazards && analysis.hazards.length > 0 && (
              <div className="mb-3 p-2.5 bg-red-500/20 rounded-lg border border-red-500/30 flex items-start gap-2">
                <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                <div>
                  <h3 className="font-semibold text-red-400 mb-1 text-sm">
                    {t.hazardsDetected}
                  </h3>
                  <ul className="list-disc list-inside space-y-0.5 text-sm">
                    {analysis.hazards.map((hazard, i) => (
                      <li key={i} className="text-red-200">
                        {hazard}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            <p className="text-white/90 leading-relaxed text-sm">
              {mode === "navigation"
                ? analysis?.navigation || t.analyzingNavigation
                : analysis?.description || t.analyzingScene}
            </p>
          </div>
        </div>

        {(conversation || isThinking) && (
          <div className="bg-gray-800/50 backdrop-blur-md rounded-2xl shadow-xl overflow-hidden ring-1 ring-white/10 p-4 text-white">
            {conversation && (
              <>
                <p className="text-indigo-300 text-xs font-semibold uppercase tracking-wide mb-1">
                  {t.youAsked}
                </p>
                <p className="text-white/70 text-sm mb-2">
                  &ldquo;{conversation.question}&rdquo;
                </p>
              </>
            )}
            <p className="text-white/90 leading-relaxed text-sm">
              {conversation?.answer || t.thinking}
            </p>
          </div>
        )}

        <VoiceSettings onVoiceSettingsChange={(text) => speak(text, false)} />

        <footer className="mt-4 p-3 border-t border-white/10 bg-black/20">
          <div className="flex items-center justify-center gap-2 text-xs text-gray-400">
            <span>View on GitHub</span>
            <a
              href="https://github.com/abhinavrnarayan/SightSoundAI-ARN"
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-400 hover:text-indigo-300 underline hover:no-underline transition-colors"
            >
              abhinavrnarayan/SightSoundAI-ARN
              <span className="sr-only">(opens in new tab)</span>
            </a>
          </div>
        </footer>
      </main>
    </div>
  );
}

export default App;
