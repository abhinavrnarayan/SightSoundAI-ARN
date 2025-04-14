import React, { useState, useEffect } from 'react';
import { ChevronDown, ChevronUp, Volume2 } from 'lucide-react';
import { translations, Language } from '../translations';

interface VoiceSettingsProps {
  onVoiceSettingsChange: (text: string) => void;
}

export function VoiceSettings({ onVoiceSettingsChange }: VoiceSettingsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [rate, setRate] = useState(() => parseFloat(localStorage.getItem('speechRate') || '1'));
  const [pitch, setPitch] = useState(() => parseFloat(localStorage.getItem('speechPitch') || '1'));
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>('');
  const [settingsChanged, setSettingsChanged] = useState(false);
  const [language, setLanguage] = useState<Language>('en');

  const t = translations[language];

  useEffect(() => {
    const savedLang = localStorage.getItem('language') as Language;
    if (savedLang && ['en', 'ml', 'hi'].includes(savedLang)) {
      setLanguage(savedLang);
    }
  }, []);

  useEffect(() => {
    const loadVoices = () => {
      const availableVoices = window.speechSynthesis.getVoices();
      setVoices(availableVoices);

      // Set default voice
      const savedVoice = localStorage.getItem('speechVoice');
      if (savedVoice && availableVoices.find(v => v.name === savedVoice)) {
        setSelectedVoice(savedVoice);
      } else {
        // Find Google Hindi voice first
        const defaultVoice = availableVoices.find(voice => 
          voice.lang === 'hi-IN' && voice.name.includes('Google')
        ) || availableVoices.find(voice => 
          voice.name.includes('Google')
        ) || availableVoices[0];
        
        if (defaultVoice) {
          setSelectedVoice(defaultVoice.name);
          localStorage.setItem('speechVoice', defaultVoice.name);
        }
      }
    };

    // Initial load
    loadVoices();

    // Setup event listener for voice loading
    window.speechSynthesis.onvoiceschanged = loadVoices;

    // Poll for voices (especially for mobile)
    const voiceCheckInterval = setInterval(() => {
      if (window.speechSynthesis.getVoices().length > 0) {
        loadVoices();
        clearInterval(voiceCheckInterval);
      }
    }, 100);

    return () => {
      clearInterval(voiceCheckInterval);
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  useEffect(() => {
    if (!settingsChanged) return;

    const voice = voices.find(v => v.name === selectedVoice);
    if (voice) {
      localStorage.setItem('speechRate', rate.toString());
      localStorage.setItem('speechPitch', pitch.toString());
      localStorage.setItem('speechVoice', selectedVoice);

      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
      }

      onVoiceSettingsChange(t.voiceSettingsUpdated);
      setSettingsChanged(false);
    }
  }, [selectedVoice, rate, pitch, voices, onVoiceSettingsChange, settingsChanged, t]);

  const handleSettingChange = () => {
    setSettingsChanged(true);
  };

  const updateVoiceSettings = () => {
    const utterance = new SpeechSynthesisUtterance(t.testMessage);
    utterance.rate = rate;
    utterance.pitch = pitch;
    
    const voice = voices.find(v => v.name === selectedVoice);
    if (voice) {
      utterance.voice = voice;
    }
    
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  };

  return (
    <div className="bg-gray-800/50 backdrop-blur-md rounded-2xl shadow-xl overflow-hidden ring-1 ring-white/10">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-4 py-3 flex items-center justify-between text-left text-white/90 hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Volume2 className="w-5 h-5" />
          <span className="font-medium">Voice Settings</span>
        </div>
        {isOpen ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
      </button>

      {isOpen && (
        <div className="p-4 space-y-4 border-t border-white/10">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-white/90">
              Voice
            </label>
            <select
              value={selectedVoice}
              onChange={(e) => {
                setSelectedVoice(e.target.value);
                handleSettingChange();
              }}
              className="w-full bg-gray-700/50 text-white rounded-lg px-3 py-2 border border-white/10"
            >
              {voices.map((voice) => (
                <option key={voice.name} value={voice.name}>
                  {`${voice.name} (${voice.lang})`}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-white/90">
              Speech Rate ({rate.toFixed(1)}x)
            </label>
            <input
              type="range"
              min="0.5"
              max="2"
              step="0.1"
              value={rate}
              onChange={(e) => {
                setRate(parseFloat(e.target.value));
                handleSettingChange();
              }}
              className="w-full accent-indigo-400"
            />
            <div className="flex justify-between text-xs text-white/60">
              <span>Slow</span>
              <span>Normal</span>
              <span>Fast</span>
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-white/90">
              Voice Pitch ({pitch.toFixed(1)})
            </label>
            <input
              type="range"
              min="0.5"
              max="2"
              step="0.1"
              value={pitch}
              onChange={(e) => {
                setPitch(parseFloat(e.target.value));
                handleSettingChange();
              }}
              className="w-full accent-indigo-400"
            />
            <div className="flex justify-between text-xs text-white/60">
              <span>Low</span>
              <span>Normal</span>
              <span>High</span>
            </div>
          </div>

          <button
            onClick={updateVoiceSettings}
            className="w-full bg-indigo-600/70 hover:bg-indigo-700/70 text-white py-2 rounded-lg transition-colors"
          >
            Test Voice
          </button>
        </div>
      )}
    </div>
  );
}