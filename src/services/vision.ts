import { GoogleGenerativeAI } from '@google/generative-ai';

function parseGeminiKeys(): string[] {
  const raw =
    (import.meta.env.VITE_GEMINI_API_KEYS as string | undefined) ??
    (import.meta.env.VITE_GEMINI_API_KEY as string | undefined) ??
    '';

  return raw
    .split(/[,;\n]/g)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !s.toUpperCase().includes('YOUR_') && !s.includes('YOUR '));
}

const GEMINI_API_KEYS = parseGeminiKeys();
let geminiKeyIndex = 0;
const geminiClients = new Map<string, GoogleGenerativeAI>();

function getClientForKey(key: string): GoogleGenerativeAI {
  const existing = geminiClients.get(key);
  if (existing) return existing;
  const created = new GoogleGenerativeAI(key);
  geminiClients.set(key, created);
  return created;
}

function getCurrentGeminiKey(): string {
  if (GEMINI_API_KEYS.length === 0) {
    throw new Error(
      'Missing Gemini API key. Set VITE_GEMINI_API_KEYS (comma-separated) or VITE_GEMINI_API_KEY in a local .env file.'
    );
  }
  return GEMINI_API_KEYS[geminiKeyIndex % GEMINI_API_KEYS.length]!;
}

function rotateGeminiKey() {
  if (GEMINI_API_KEYS.length <= 1) return;
  geminiKeyIndex = (geminiKeyIndex + 1) % GEMINI_API_KEYS.length;
}

function shouldRotateKey(error: unknown): boolean {
  const msg =
    typeof error === 'object' && error && 'message' in error
      ? String((error as { message?: unknown }).message)
      : String(error);
  // Catch common quota / rate limit / key issues.
  return (
    msg.includes('429') ||
    msg.toLowerCase().includes('resource_exhausted') ||
    msg.toLowerCase().includes('quota') ||
    msg.toLowerCase().includes('rate') ||
    msg.toLowerCase().includes('limit') ||
    msg.toLowerCase().includes('api key not valid') ||
    msg.toLowerCase().includes('permission') ||
    msg.toLowerCase().includes('unauth')
  );
}

async function withGeminiKeyRotation<T>(fn: (genAI: GoogleGenerativeAI) => Promise<T>): Promise<T> {
  let lastError: unknown;
  const attempts = Math.max(1, GEMINI_API_KEYS.length);

  for (let i = 0; i < attempts; i++) {
    const key = getCurrentGeminiKey();
    const client = getClientForKey(key);
    try {
      return await fn(client);
    } catch (err) {
      lastError = err;
      if (GEMINI_API_KEYS.length > 1 && shouldRotateKey(err)) {
        rotateGeminiKey();
        continue;
      }
      throw err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

type InlineDataPart = { inlineData: { data: string; mimeType: string } };
type GenerateContentInput = Array<string | InlineDataPart>;

async function generateContentWithRotation(input: GenerateContentInput) {
  return withGeminiKeyRotation(async (genAI) => {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    return model.generateContent(input);
  });
}

// Helper function to translate hazards to Malayalam and Hindi
const translateHazardsToLanguage = (hazards: string[], language: string): string[] => {
  const hazardTranslations: { [key: string]: { ml: string; hi: string } } = {
    'stairs': { ml: 'പടികൾ', hi: 'सीढ़ियां' },
    'step': { ml: 'പടി', hi: 'सीढ़ी' },
    'uneven surface': { ml: 'അസമമായ പ്രതലം', hi: 'असमान सतह' },
    'obstacle': { ml: 'തടസ്സം', hi: 'बाधा' },
    'moving object': { ml: 'ചലിക്കുന്ന വസ്തു', hi: 'चलती वस्तु' },
    'vehicle': { ml: 'വാഹനം', hi: 'वाहन' },
    'person': { ml: 'വ്യക്തി', hi: 'व्यक्ति' },
    'crowd': { ml: 'ജനക്കൂട്ടം', hi: 'भीड़' },
    'water': { ml: 'വെള്ളം', hi: 'पानी' },
    'hole': { ml: 'കുഴി', hi: 'गड्ढा' },
    'construction': { ml: 'നിർമ്മാണം', hi: 'निर्माण' },
    'wet floor': { ml: 'നനഞ്ഞ തറ', hi: 'गीला फर्श' },
    'traffic': { ml: 'ഗതാഗതം', hi: 'यातायात' },
    'door': { ml: 'വാതിൽ', hi: 'दरवाजा' },
    'wall': { ml: 'ചുമർ', hi: 'दीवार' },
    'furniture': { ml: 'ഫർണിച്ചർ', hi: 'फर्नीचर' },
    'glass': { ml: 'ഗ്ലാസ്', hi: 'कांच' },
    'sharp object': { ml: 'മൂർച്ചയുള്ള വസ്തു', hi: 'तेज वस्तु' },
    'electric': { ml: 'വൈദ്യുതി', hi: 'बिजली' },
    'hot surface': { ml: 'ചൂടുള്ള പ്രതലം', hi: 'गर्म सतह' }
  };

  return hazards.map(hazard => {
    const lowerHazard = hazard.toLowerCase();
    for (const [eng, translations] of Object.entries(hazardTranslations)) {
      if (lowerHazard.includes(eng)) {
        return translations[language as 'ml' | 'hi'] || hazard;
      }
    }
    return hazard; // Return original if no translation found
  });
};

export async function analyzeImage(base64Image: string, language: string = 'en') {
  try {
    if (!base64Image || !base64Image.includes('base64')) {
      throw new Error('Invalid image data provided');
    }

    const imageData = base64Image.split(',')[1];
    if (!imageData) {
      throw new Error('Invalid base64 image format');
    }

    // First, analyze for hazards in English for consistent detection
    const hazardResult = await generateContentWithRotation([
      'Analyze this image for any potential hazards or dangers that a visually impaired person should be warned about. Focus on immediate threats like weapons, vehicles, obstacles, or dangerous situations. Respond with ONLY the hazards in a comma-separated list. If no hazards are found, respond with "NONE".',
      { inlineData: { data: imageData, mimeType: 'image/jpeg' } }
    ]);
    
    const hazardText = hazardResult.response.text();
    const hazards = hazardText === 'NONE' ? [] : hazardText.split(',').map(h => h.trim());

    // Get scene description with specific language instructions
    let descriptionPrompt = 'Describe this scene in a single, clear sentence (50 words or less). Focus on the main elements and their arrangement.';
    
    if (language === 'ml') {
      descriptionPrompt = `Provide a natural Malayalam language description of this scene in a single sentence (50 words or less). Use proper Malayalam grammar and natural phrasing. Focus on describing the main elements and their arrangement in a way that sounds natural to Malayalam speakers. Respond ONLY in Malayalam script.`;
    } else if (language === 'hi') {
      descriptionPrompt = `इस दृश्य का एक प्राकृतिक हिंदी भाषा में वर्णन करें (50 शब्दों से कम में)। उचित हिंदी व्याकरण और प्राकृतिक वाक्य रचना का उपयोग करें। मुख्य तत्वों और उनकी व्यवस्था का वर्णन करें। केवल देवनागरी लिपि में उत्तर दें।`;
    }

    const descResult = await generateContentWithRotation([
      descriptionPrompt,
      { inlineData: { data: imageData, mimeType: 'image/jpeg' } }
    ]);
    const description = descResult.response.text().split(/[.!?]/, 1)[0].trim();

    // Extract objects from the description (keep in English for consistency)
    const commonObjects = ['person', 'chair', 'table', 'computer', 'phone', 'book', 'window', 'door', 'wall', 'desk', 'lamp', 'screen', 'monitor', 'keyboard', 'mouse', 'headphone', 'camera', 'wire', 'cable', 'jacket', 'shirt', 'pants', 'shoes'];
    const objectMatches = description.toLowerCase().match(new RegExp(`\\b(${commonObjects.join('|')})\\b`, 'g')) || [];
    const objects = [...new Set(objectMatches)];

    return {
      objects,
      description,
      hazards: language === 'en' ? hazards : translateHazardsToLanguage(hazards, language)
    };
  } catch (error) {
    console.error('Error analyzing image:', error);
    throw error;
  }
}

export async function analyzeForNavigation(base64Image: string, language: string = 'en') {
  try {
    if (!base64Image || !base64Image.includes('base64')) {
      throw new Error('Invalid image data provided');
    }

    const imageData = base64Image.split(',')[1];
    if (!imageData) {
      throw new Error('Invalid base64 image format');
    }

    // First, analyze for hazards in English for consistent detection
    const hazardResult = await generateContentWithRotation([
      'Analyze this image for any potential hazards or dangers that a visually impaired person should be warned about while navigating. Focus on immediate obstacles, steps, uneven surfaces, or moving objects. Respond with ONLY the hazards in a comma-separated list. If no hazards are found, respond with "NONE".',
      { inlineData: { data: imageData, mimeType: 'image/jpeg' } }
    ]);
    
    const hazardText = hazardResult.response.text();
    const hazards = hazardText === 'NONE' ? [] : hazardText.split(',').map(h => h.trim());

    // Get navigation guidance with specific language instructions
    let navigationPrompt = 'Analyze this scene and provide clear, concise navigation guidance for a visually impaired person. Include information about safe paths, obstacles to avoid, and suggested directions. Keep it under 50 words and focus on immediate, actionable guidance.';
    
    if (language === 'ml') {
      navigationPrompt = `Provide natural Malayalam language navigation guidance for a visually impaired person. Include information about safe paths, obstacles to avoid, and suggested directions. Use proper Malayalam grammar and natural phrasing. Keep it under 50 words and respond ONLY in Malayalam script.`;
    } else if (language === 'hi') {
      navigationPrompt = `एक दृष्टिबाधित व्यक्ति के लिए प्राकृतिक हिंदी भाषा में नेविगेशन मार्गदर्शन प्रदान करें। सुरक्षित रास्तों, बचने योग्य बाधाओं और सुझाए गए दिशाओं की जानकारी शामिल करें। 50 शब्दों से कम में और केवल देवनागरी लिपि में उत्तर दें।`;
    }

    const navResult = await generateContentWithRotation([
      navigationPrompt,
      { inlineData: { data: imageData, mimeType: 'image/jpeg' } }
    ]);
    const navigation = navResult.response.text().split(/[.!?]/, 1)[0].trim();

    return {
      navigation,
      hazards: language === 'en' ? hazards : translateHazardsToLanguage(hazards, language)
    };
  } catch (error) {
    console.error('Error analyzing image for navigation:', error);
    throw error;
  }
}