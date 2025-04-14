export type Language = 'en' | 'ml' | 'hi';

export const translations = {
  en: {
    switchedToMode: (mode: string) => `Switched to ${mode} mode`,
    sceneMode: 'scene description',
    navigationMode: 'navigation',
    analyzing: 'Analyzing...',
    listeningToCommand: 'Listening to command...',
    autoAnalyzing: 'Auto-analyzing',
    hazardsDetected: 'Potential Hazards Detected',
    noHazards: "I don't see any immediate hazards in the scene.",
    detectedHazards: (hazards: string[]) => `I detected the following hazards: ${hazards.join(', ')}`,
    analyzingScene: 'Analyzing scene...',
    analyzingNavigation: 'Analyzing navigation...',
    errorAnalyzing: "I'm having trouble analyzing the image. Please try again.",
    voiceSettingsUpdated: 'Voice settings updated',
    testMessage: 'This is a test message with the current voice settings'
  },
  ml: {
    switchedToMode: (mode: string) => `${mode === 'scene' ? 'ദൃശ്യ വിവരണം' : 'നാവിഗേഷൻ'} മോഡിലേക്ക് മാറി`,
    sceneMode: 'ദൃശ്യ വിവരണം',
    navigationMode: 'നാവിഗേഷൻ',
    analyzing: 'വിശകലനം ചെയ്യുന്നു...',
    listeningToCommand: 'നിർദ്ദേശം കേൾക്കുന്നു...',
    autoAnalyzing: 'സ്വയം വിശകലനം ചെയ്യുന്നു',
    hazardsDetected: 'സാധ്യമായ അപകടങ്ങൾ കണ്ടെത്തി',
    noHazards: 'ദൃശ്യത്തിൽ അപകടങ്ങളൊന്നും കാണുന്നില്ല.',
    detectedHazards: (hazards: string[]) => `ഞാൻ കണ്ടെത്തിയ അപകടങ്ങൾ: ${hazards.join(', ')}`,
    analyzingScene: 'ദൃശ്യം വിശകലനം ചെയ്യുന്നു...',
    analyzingNavigation: 'നാവിഗേഷൻ വിശകലനം ചെയ്യുന്നു...',
    errorAnalyzing: 'ചിത്രം വിശകലനം ചെയ്യുന്നതിൽ പ്രശ്നമുണ്ട്. ദയവായി വീണ്ടും ശ്രമിക്കുക.',
    voiceSettingsUpdated: 'വോയ്‌സ് ക്രമീകരണങ്ങൾ അപ്‌ഡേറ്റ് ചെയ്‌തു',
    testMessage: 'ഇത് നിലവിലെ വോയ്‌സ് ക്രമീകരണങ്ങളുള്ള ഒരു പരീക്ഷണ സന്ദേശമാണ്'
  },
  hi: {
    switchedToMode: (mode: string) => `${mode === 'scene' ? 'दृश्य विवरण' : 'नेविगेशन'} मोड में बदल गया`,
    sceneMode: 'दृश्य विवरण',
    navigationMode: 'नेविगेशन',
    analyzing: 'विश्लेषण कर रहा है...',
    listeningToCommand: 'कमांड सुन रहा है...',
    autoAnalyzing: 'स्वचालित विश्लेषण',
    hazardsDetected: 'संभावित खतरे पाए गए',
    noHazards: 'दृश्य में कोई तत्काल खतरा नहीं दिखाई दे रहा है।',
    detectedHazards: (hazards: string[]) => `मैंने निम्नलिखित खतरे पाए: ${hazards.join(', ')}`,
    analyzingScene: 'दृश्य का विश्लेषण कर रहा है...',
    analyzingNavigation: 'नेविगेशन का विश्लेषण कर रहा है...',
    errorAnalyzing: 'छवि का विश्लेषण करने में समस्या है। कृपया पुनः प्रयास करें।',
    voiceSettingsUpdated: 'वॉइस सेटिंग्स अपडेट की गईं',
    testMessage: 'यह वर्तमान वॉइस सेटिंग्स के साथ एक परीक्षण संदेश है'
  }
} as const;