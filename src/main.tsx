import "regenerator-runtime/runtime";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { initAnalytics, trackEvent, trackPerformance } from "./firebase";
import "./index.css";

// Pre-load voices when the page loads
const loadVoices = () => {
  return new Promise<void>((resolve) => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      // If voices are already loaded, resolve immediately
      if (window.speechSynthesis.getVoices().length > 0) {
        resolve();
        return;
      }

      // Wait for voices to be loaded
      window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
        resolve();
      };
    } else {
      resolve();
    }
  });
};

// Initialize Firebase Analytics early (non-blocking)
const appStartTime = performance.now();
initAnalytics().then(() => {
  const initTime = Math.round(performance.now() - appStartTime);
  
  // Track session start with performance metrics
  trackEvent('session_start', {
    timestamp: new Date().toISOString(),
    user_agent: navigator.userAgent,
    screen_width: window.screen.width,
    screen_height: window.screen.height,
    analytics_init_time_ms: initTime,
  });
  
  // Track analytics initialization performance
  trackPerformance('analytics_initialization', initTime);
});

// Initialize speech synthesis
loadVoices().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
});
