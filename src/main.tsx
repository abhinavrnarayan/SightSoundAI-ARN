import 'regenerator-runtime/runtime';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Pre-load voices when the page loads
const loadVoices = () => {
  return new Promise<void>((resolve) => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
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

// Initialize speech synthesis
loadVoices().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
});