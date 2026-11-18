import { GoogleGenerativeAI } from '@google/generative-ai';
import { trackKeyRotation } from '../firebase';

// Downscale webcam screenshots before sending to Gemini.
// Smaller payload = faster upload, fewer tokens, quicker responses.
async function compressImage(
  dataUrl: string,
  maxDimension = 512,
  quality = 0.7
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDimension || height > maxDimension) {
        const scale = maxDimension / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => reject(new Error('Image compression failed'));
    img.src = dataUrl;
  });
}

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
  trackKeyRotation('quota_or_rate_limit');
}

function shouldRotateKey(error: unknown): boolean {
  const msg =
    typeof error === 'object' && error && 'message' in error
      ? String((error as { message?: unknown }).message)
      : String(error);
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

// Single combined prompt that returns hazards, description/navigation, and objects in one API call.
// This cuts latency in half compared to two separate calls.
function buildAnalysisPrompt(mode: 'scene' | 'navigation', language: string): string {
  if (mode === 'navigation') {
    if (language === 'ml') {
      return `നavioigate ചെയ്യുന്ന ദൃശ്യവിശകലനം നടത്തുക. നിഗംനിത്മാര-ൽ puestos:
HAZARDS: അപകടങ്ങളുടെкомма-vigraṇicka പട്ടിക, അല്ലെങ്കിൽ "NONE".
NAVIGATION: സുരക്ഷित പാത, ഒഴിവാക്കേണ്ട തടസ്സങ്ങൾ, ദിശ (50 വാക്കിൽ താഴെ), മലയാളത്തിൽ മാത്രം.
ഉത്തരം ഇங்க്‌ലീഷ്‌ Männern respuesta നൽകേണ്ടതില്ല.`
    }
    if (language === 'hi') {
      return `नेविगेशन विश्लेषण करें:
HAZARDS: खतरों की कॉमा-सेपरेटेड सूची, या "NONE".
NAVIGATION: सुरक्षित रास्ता, बचने योग्य बाधाएं, सुझाई गई दिशा (50 शब्दों से कम), हिंदी में केवल देवनागरी लिपि में.
उत्तर केवल हिंदी में दें।`
    }
    return `Analyze this scene for navigation guidance for a visually impaired person.
HAZARDS: comma-separated list of immediate hazards (steps, uneven surfaces, obstacles, vehicles, moving objects), or "NONE" if none.
NAVIGATION: clear, concise navigation guidance - safe path, obstacles to avoid, suggested direction (under 50 words).
Respond in English only. Format exactly as shown above.`;
  }

  // Scene mode
  if (language === 'ml') {
    return `ദൃശ്യവിശകലനം നടത്തുക:
HAZARDS: അപകടങ്ങൾ, അല്ലെങ്കിൽ "NONE".
DESCRIPTION: ദൃശ്യത്തിന്റെ ഒരു വാചകം വിവരണം (50 വാക്കിൽ താഴെ), മലയാളത്തിൽ മാത്രം.
OBJECTS: അവിടെ കാണുന്ന വസ്തുക്കൾ (ഇംഗ്ലീഷിൽ).
ഉത്തരം മലയാളത്തിൽ മാത്രം നൽകുക.`
  }
  if (language === 'hi') {
    return `दृश्य विश्लेषण करें:
HAZARDS: खतरे, या "NONE".
DESCRIPTION: दृश्य का एक वाक्य विवरण (50 शब्दों से कम), केवल देवनागरी लिपि में हिंदी में.
OBJECTS: दिखने वाली वस्तुएं (अंग्रेजी में).
उत्तर केवल हिंदी में दें।`
  }
  return `Analyze this scene for a visually impaired person.
HAZARDS: comma-separated list of immediate hazards, or "NONE" if none.
DESCRIPTION: one clear sentence describing the scene (under 50 words).
OBJECTS: comma-separated list of objects visible in English.
Respond in English only. Format exactly as shown above.`;
}

function parseAnalysisResponse(text: string, mode: 'scene' | 'navigation', language: string) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let hazards = '';
  let description = '';
  let objects = '';
  let navigation = '';

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith('HAZARDS:')) {
      hazards = line.slice('HAZARDS:'.length).trim();
    } else if (upper.startsWith('DESCRIPTION:')) {
      description = line.slice('DESCRIPTION:'.length).trim();
    } else if (upper.startsWith('OBJECTS:')) {
      objects = line.slice('OBJECTS:'.length).trim();
    } else if (upper.startsWith('NAVIGATION:')) {
      navigation = line.slice('NAVIGATION:'.length).trim();
    }
  }

  const hazardList =
    hazards === 'NONE' || !hazards
      ? []
      : hazards.split(',').map((h) => h.trim()).filter(Boolean);

  const objectList = objects
    ? objects.split(',').map((o) => o.trim()).filter(Boolean)
    : [];

  return {
    hazards:
      language === 'en'
        ? hazardList
        : translateHazardsToLanguage(hazardList, language),
    description,
    objects: objectList,
    navigation,
  };
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
    return hazard;
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

    // Compress before sending to reduce payload size and analysis time.
    const compressed = await compressImage(`data:image/jpeg;base64,${imageData}`);
    const compressedData = compressed.split(',')[1] || imageData;

    // Single API call returns hazards, description, and objects together
    const result = await generateContentWithRotation([
      buildAnalysisPrompt('scene', language),
      { inlineData: { data: compressedData, mimeType: 'image/jpeg' } }
    ]);

    const parsed = parseAnalysisResponse(result.response.text(), 'scene', language);
    return {
      objects: parsed.objects,
      description: parsed.description,
      hazards: parsed.hazards,
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

    // Compress before sending to reduce payload size and analysis time.
    const compressed = await compressImage(`data:image/jpeg;base64,${imageData}`);
    const compressedData = compressed.split(',')[1] || imageData;

    // Single API call returns hazards and navigation together
    const result = await generateContentWithRotation([
      buildAnalysisPrompt('navigation', language),
      { inlineData: { data: compressedData, mimeType: 'image/jpeg' } }
    ]);

    const parsed = parseAnalysisResponse(result.response.text(), 'navigation', language);
    return {
      navigation: parsed.navigation,
      hazards: parsed.hazards,
    };
  } catch (error) {
    console.error('Error analyzing image for navigation:', error);
    throw error;
  }
}
