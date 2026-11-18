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
  trackSettingsChanged,
  trackMicrophonePermission,
  trackSpeechSupport,
  trackCameraError,
  trackKeyRotation,
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
import { analyzeImage, analyzeForNavigation } from "./services/vision";
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
  const webcamRef = useRef<Webcam>(null);
  const speechRef = useRef<SpeechSynthesisUtterance | null>(null);
  const analysisIntervalRef = useRef<number | null>(null);
  const pauseTimeoutRef = useRef<number | null>(null);
  const imageAnalysisCountRef = useRef<number>(0);
  const totalSpeakingTimeRef = useRef<number>(0);
  const speakingStartTimeRef = useRef<number | null>(null);
  const lastInteractionTimeRef = useRef<number>(Date.now());
  const lastCaptureTimeRef = useRef<number>(0);
  const CAPTURE_COOLDOWN_MS = 3000; // Minimum gap between auto-captures (reduced for lower latency)
  const firstCaptureRef = useRef<boolean>(false);
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
  const welcomeSpokenRef = useRef<boolean>(false);

  const t = translations[language];

  const handleModeSwitch = (newMode: "scene" | "navigation") => {
    const previousMode = mode;
    setMode(newMode);
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

  useEffect(() => {
    const savedLang = localStorage.getItem("language") as Language;
    if (savedLang && ["en", "ml", "hi"].includes(savedLang)) {
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

  const {
    listening,
    browserSupportsSpeechRecognition,
    isMicrophoneAvailable,
  } = useSpeechRecognition({
    commands: [
      {
        command: [
          "switch to navigation",
          "navigation mode",
          "enable navigation",
          "start navigation",
          "begin navigation",
          "navigate",
          "नेविगेशन",
          "नेविगेट",
          "നാവിഗേഷൻ",
          "നാവിഗേഷൻ മോഡ്",
        ],
        callback: () => {
          if (!isStarted) return;
          voiceCommandRef.current = { onCommand: () => handleModeSwitch("navigation") };
          speak(t.switchedToMode("navigation"), true);
        },
        isFuzzyMatch: true,
        fuzzyMatchingThreshold: 0.6,
      },
      {
        command: [
          "switch to scene",
          "scene mode",
          "scene description",
          "enable scene",
          "start scene",
          "describe scene",
          "what do you see",
          "दृश्य विवरण",
          "दृश्य मोड",
          "ദൃശ്യ വിവരണം",
          "സീൻ മോഡ്",
        ],
        callback: () => {
          if (!isStarted) return;
          voiceCommandRef.current = { onCommand: () => handleModeSwitch("scene") };
          speak(t.switchedToMode("scene"), true);
        },
        isFuzzyMatch: true,
        fuzzyMatchingThreshold: 0.6,
      },
      {
        command: [
          "start",
          "begin",
          "start app",
          "开始",
          "शुरू करें",
          "തുടங்கുക",
        ],
        callback: () => {
          setIsStarted(true);
          setIsPaused(false);
          speak(t.welcomeMessage, true);
        },
        isFuzzyMatch: true,
        fuzzyMatchingThreshold: 0.6,
      },
      {
        command: [
          "stop",
          "pause",
          "stop app",
          "रोकें",
          "നിർത്തുക",
        ],
        callback: () => {
          setIsPaused(true);
          window.speechSynthesis.cancel();
          speak(t.stopMessage, true);
        },
        isFuzzyMatch: true,
        fuzzyMatchingThreshold: 0.6,
      },
      {
        command: [
          "restart",
          "resume",
          "continue",
          "पुनः शुरू करें",
          "മulai ചെയ്യുക",
        ],
        callback: () => {
          setIsPaused(false);
          speak(t.restartMessage, true);
        },
        isFuzzyMatch: true,
        fuzzyMatchingThreshold: 0.6,
      },
      {
        command: [
          "hazards",
          "dangers",
          "what are the hazards",
          "any dangers",
          "खतरे",
          "कोई खतरा",
          "അപകടങ്ങൾ",
          "അപകട സാധ്യതകൾ",
        ],
        callback: () => {
          if (!isStarted) return;
          if (analysis?.hazards) {
            const response =
              analysis.hazards.length > 0
                ? t.detectedHazards(analysis.hazards)
                : t.noHazards;
            speak(response, true);

            // Track voice command for hazards
            trackEngagement("voice_command", {
              command: "hazards_query",
              language: language,
              hazards_found: analysis.hazards.length > 0,
              hazard_count: analysis.hazards.length,
              mode: mode,
            });
          }
        },
      },
      {
        command: [
          "switch language",
          "change language",
          "toggle language",
          "भाषा बदलें",
          "ഭാഷ മാറ്റുക",
        ],
        callback: () => {
          if (!isStarted) return;
          handleLanguageToggle();
        },
        isFuzzyMatch: true,
        fuzzyMatchingThreshold: 0.6,
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

    // Mention key objects naturally
    if (result.objects && result.objects.length > 0) {
      const objectList = result.objects.slice(0, 5).join(', ');
      parts.push(`I can see ${objectList} nearby.`);
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

  const handleCapture = useCallback(async (shouldPreload = false) => {    if (!webcamRef.current || isPaused) return;

    setIsCapturing(true);
    const analysisStartTime = performance.now();
    const imageSrc = webcamRef.current.getScreenshot();

    try {
      if (!imageSrc) {
        console.warn("No image captured from webcam");
        trackError("No image captured from webcam", { mode, language });
        return;
      }

      imageAnalysisCountRef.current += 1;
      lastInteractionTimeRef.current = Date.now();

      // Track engagement
      trackEngagement("image_capture", {
        mode,
        language,
        analysis_count: imageAnalysisCountRef.current,
      });

      if (mode === "navigation") {
        const result = await analyzeForNavigation(imageSrc, language);
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
          language: language,
          hazards_detected: result.hazards.length,
          hazard_types: result.hazards.join(","),
          has_navigation_guidance: !!result.navigation,
          navigation_length: result.navigation?.length || 0,
          analysis_duration_ms: analysisDuration,
          total_analyses: imageAnalysisCountRef.current,
        });

        // Track performance
        trackPerformance("navigation_analysis", analysisDuration);

        if (shouldPreload || isSpeaking) {
          // Preload while narrating - store for next turn
          preloadedAnalysisRef.current = analysisResult;
        } else {
          setAnalysis({
            objects: [],
            description: result.navigation || "",
            hazards: result.hazards,
            navigation: result.navigation,
          });

          if (!isPaused && !isSpeaking) {
            speak(buildNavigationSpeech(result), false);
          }
        }
      } else {
        const result = await analyzeImage(imageSrc, language);
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
          language: language,
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

        if (shouldPreload || isSpeaking) {
          // Preload while narrating - store for next turn
          preloadedAnalysisRef.current = analysisResult;
        } else {
          setAnalysis(result);

          if (!isPaused && !isSpeaking) {
            speak(buildSceneSpeech(result), false);
          }
        }
      }
    } catch (error) {
      const errorDuration = Math.round(performance.now() - analysisStartTime);
      console.error("Error analyzing image:", error);
      
      // Track error with context
      trackError(error instanceof Error ? error : new Error(String(error)), {
        mode,
        language,
        analysis_duration_ms: errorDuration,
        analysis_count: imageAnalysisCountRef.current,
      });
      
      speak(t.errorAnalyzing, true);
    } finally {
      setIsCapturing(false);
    }
  }, [isPaused, isSpeaking, mode, language, t]);

  useEffect(() => {
    const interval = 10;
    let timeLeft = interval;

    // Capture immediately on mount to remove the initial ~10s delay.
    if (!firstCaptureRef.current && !isPaused && !isSpeaking) {
      firstCaptureRef.current = true;
      lastCaptureTimeRef.current = Date.now();
      handleCapture();
    }

    analysisIntervalRef.current = window.setInterval(() => {
      // Pause auto-capture when the tab is hidden (user switched away / minimized).
      if (document.visibilityState === 'hidden') {
        timeLeft = interval;
        return;
      }
      if (isPaused || isCapturing) {
        timeLeft = interval;
        return;
      }
      // Enforce a minimum cooldown between captures to avoid hammering the API.
      if (Date.now() - lastCaptureTimeRef.current < CAPTURE_COOLDOWN_MS) {
        return;
      }

      if (timeLeft <= 0) {
        lastCaptureTimeRef.current = Date.now();
        // Normal capture (not preloading - preloading is handled in speak onstart).
        handleCapture(false);
        timeLeft = interval;
      } else {
        timeLeft--;
      }
    }, 1000);

    return () => {
      if (analysisIntervalRef.current) {
        clearInterval(analysisIntervalRef.current);
      }
      if (pauseTimeoutRef.current) {
        clearTimeout(pauseTimeoutRef.current);
      }
    };
  }, [handleCapture, isPaused, isSpeaking, isCapturing]);

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

  // Auto-speak welcome message on welcome screen so blind users know what to do.
  useEffect(() => {
    if (!isStarted && !welcomeSpokenRef.current) {
      welcomeSpokenRef.current = true;
      speak(t.welcomeMessage, true);
    }
  }, [isStarted, t.welcomeMessage]);

  useEffect(() => {
    if (browserSupportsSpeechRecognition) {
      SpeechRecognition.startListening({ continuous: true });
    }

    return () => {
      SpeechRecognition.stopListening();
    };
  }, [browserSupportsSpeechRecognition]);

  const speak = (text: string, isCommand: boolean) => {
    if (speechRef.current) {
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
      setIsSpeaking(true);
      speakingStartTimeRef.current = performance.now();

      // Start preloading the next analysis immediately when TTS starts,
      // so it's ready by the time narration finishes (zero-latency transition).
      if (!isPaused && webcamRef.current) {
        handleCapture(true);
      }

      // Track speech start
      trackEngagement("speech_started", {
        text_length: text.length,
        is_command: isCommand,
        language: language,
      });
    };
    
    speechRef.current.onend = () => {
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
          language: language,
        });
        
        speakingStartTimeRef.current = null;
      }

      // If we preloaded the next analysis while speaking, use it now for zero-latency transition.
      if (!isCommand && preloadedAnalysisRef.current && !isPaused) {
        const preloaded = preloadedAnalysisRef.current;
        preloadedAnalysisRef.current = null;

        if (preloaded.mode === "navigation") {
          setAnalysis({
            objects: [],
            description: preloaded.description,
            hazards: preloaded.hazards,
            navigation: preloaded.navigation,
          });
          speak(buildNavigationSpeech(preloaded), false);
        } else {
          setAnalysis({
            objects: preloaded.objects,
            description: preloaded.description,
            hazards: preloaded.hazards,
            navigation: undefined,
          });
          speak(buildSceneSpeech(preloaded), false);
        }
        return;
      }

      if (isCommand) {
        if (pauseTimeoutRef.current) {
          clearTimeout(pauseTimeoutRef.current);
        }

        pauseTimeoutRef.current = window.setTimeout(() => {
          setIsPaused(false);
          pauseTimeoutRef.current = null;
        }, 2000);
      }

      // Execute any deferred voice command that was recognized while speaking.
      if (voiceCommandRef.current) {
        const cmd = voiceCommandRef.current;
        voiceCommandRef.current = null;
        cmd.onCommand();
      }
    };

    window.speechSynthesis.speak(speechRef.current);
  };

  const stopSpeaking = () => {
    window.speechSynthesis.cancel();
    setIsSpeaking(false);

    // Calculate interrupted speaking time
    let interruptedDuration = 0;
    if (speakingStartTimeRef.current) {
      interruptedDuration = Math.round(performance.now() - speakingStartTimeRef.current);
      speakingStartTimeRef.current = null;
    }

    // Track speech stopped with metrics
    trackEngagement("speech_stopped", {
      method: "user_action",
      language: language,
      interrupted_duration_ms: interruptedDuration,
      total_speaking_time_ms: totalSpeakingTimeRef.current,
    });

    if (pauseTimeoutRef.current) {
      clearTimeout(pauseTimeoutRef.current);
    }

    setTimeout(() => {
      setIsPaused(false);
    }, 500);
  };

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
            onClick={() => {
              setIsStarted(true);
              speak(t.welcomeMessage, true);
            }}
            className="w-full bg-indigo-600 hover:bg-indigo-500 text-white py-4 px-8 rounded-full text-lg font-semibold transition-colors"
          >
            Start SightSound AI
          </button>
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
                onClick={isSpeaking ? stopSpeaking : undefined}
                className={`p-1.5 rounded-full transition-colors ${
                  isSpeaking
                    ? "bg-red-500/70 hover:bg-red-600/70"
                    : "bg-indigo-600/70 hover:bg-indigo-700/70"
                }`}
              >
                {isSpeaking ? (
                  <StopCircle className="w-5 h-5" />
                ) : (
                  <Volume2 className="w-5 h-5" />
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
            {isCapturing
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
