import { GoogleGenerativeAI } from '@google/generative-ai';
import { trackKeyRotation } from '../firebase';
import { parseAnalysisResponse } from './analysisParser';
import { readResponseText } from './responseText';

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

// The newest flash-lite model answers a scene in about 1.4s, and it is the
// only model that every key in .env can reach. The older flash model stays as
// a fallback for a key or a project that cannot serve the newer one.
const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-2.5-flash'];

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

function rotateGeminiKey(reason: string) {
  if (GEMINI_API_KEYS.length <= 1) return;
  geminiKeyIndex = (geminiKeyIndex + 1) % GEMINI_API_KEYS.length;
  trackKeyRotation(reason);
}

/**
 * Sorts a failure into the action that can fix it.
 *
 * "model" means the model cannot serve this key. Another model can serve it.
 * "key" means the key is exhausted, blocked or busy. Another key can serve it.
 * "fatal" means the request itself is wrong, so a retry cannot help.
 */
function classifyGeminiError(error: unknown): 'model' | 'key' | 'fatal' {
  const msg =
    typeof error === 'object' && error && 'message' in error
      ? String((error as { message?: unknown }).message)
      : String(error);
  const lower = msg.toLowerCase();

  if (
    msg.includes('404') ||
    (lower.includes('model') && (lower.includes('not found') || lower.includes('not available')))
  ) {
    return 'model';
  }

  if (
    msg.includes('429') ||
    msg.includes('503') ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests') ||
    lower.includes('high demand') ||
    lower.includes('overloaded') ||
    lower.includes('unavailable') ||
    lower.includes('api key not valid') ||
    lower.includes('permission') ||
    lower.includes('unauth')
  ) {
    return 'key';
  }

  return 'fatal';
}

function rotationReason(error: unknown): string {
  const msg = String((error as { message?: unknown })?.message ?? '').toLowerCase();
  if (msg.includes('503') || msg.includes('high demand') || msg.includes('overloaded')) {
    return 'model_unavailable';
  }
  if (msg.includes('401') || msg.includes('403') || msg.includes('api key') || msg.includes('permission')) {
    return 'key_rejected';
  }
  return 'quota_or_rate_limit';
}

async function withGeminiRetry<T>(
  fn: (genAI: GoogleGenerativeAI, model: string) => Promise<T>
): Promise<T> {
  let lastError: unknown;
  const attempts = Math.max(1, GEMINI_API_KEYS.length);

  for (let i = 0; i < attempts; i++) {
    const key = getCurrentGeminiKey();
    const client = getClientForKey(key);
    for (let m = 0; m < GEMINI_MODELS.length; m++) {
      try {
        return await fn(client, GEMINI_MODELS[m]!);
      } catch (err) {
        lastError = err;
        const kind = classifyGeminiError(err);
        if (kind === 'model') {
          // This model cannot serve this key. Try the next model.
          continue;
        }
        if (kind === 'key' && GEMINI_API_KEYS.length > 1) {
          rotateGeminiKey(rotationReason(err));
          break;
        }
        throw err;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

type InlineDataPart = { inlineData: { data: string; mimeType: string } };
type GenerateContentInput = Array<string | InlineDataPart>;

async function generateContentWithRotation(input: GenerateContentInput) {
  return withGeminiRetry(async (genAI, model) => {
    const generativeModel = genAI.getGenerativeModel({ model });
    return generativeModel.generateContent(input);
  });
}

// Single combined prompt that returns hazards, description/navigation, and objects in one API call.
// This cuts latency in half compared to two separate calls.
function buildAnalysisPrompt(mode: 'scene' | 'navigation', language: string): string {
  if (mode === 'navigation') {
    if (language === 'ml') {
      return `നാവിഗേഷൻ വിശകലനം ചെയ്യുക:
HAZARDS: അപകടങ്ങളുടെ പട്ടിക, അല്ലെങ്കിൽ "NONE".
NAVIGATION: നേരിൽ ഉള്ളവ, ഒഴിവാക്കേണ്ട തടസ്സങ്ങൾ, അടുത്ത നടപ്പ് (30 വാക്കിൽ താഴെ), മലയാളത്തിൽ മാത്രം.
ഉത്തരം മലയാളത്തിൽ മാത്രം നൽകുക.`
    }
    if (language === 'hi') {
      return `नेविगेशन विश्लेषण करें:
HAZARDS: खतरों की कॉमा-सेपरेटेड सूची, या "NONE".
NAVIGATION: सामने क्या है, किन बाधाओं से बचें, और अगला कदम (30 शब्दों से कम), हिंदी में केवल देवनागरी लिपि में.
उत्तर केवल हिंदी में दें।`
    }
    return `Analyze this scene for navigation guidance for a visually impaired person.
HAZARDS: comma-separated list of immediate hazards (steps, uneven surfaces, obstacles, vehicles, moving objects), or "NONE" if none.
NAVIGATION: what is directly ahead within two steps, what to avoid, and the next step to take, for example "a chair is one step ahead on the left, step right to pass it" (under 30 words).
Respond in English only. Format exactly as shown above.`;
  }

  // Scene mode
  if (language === 'ml') {
    return `ദൃശ്യവിശകലനം നടത്തുക:
HAZARDS: അപകടങ്ങൾ, അല്ലെങ്കിൽ "NONE".
DESCRIPTION: ദൃശ്യത്തിന്റെ ഒരു വ്യക്തമായ വിവരണം, സ്ഥാനങ്ങളും ഉൾപ്പെടുത്തി (50 വാക്കിൽ താഴെ), മലയാളത്തിൽ മാത്രം.
OBJECTS: അവിടെ കാണുന്ന വസ്തുക്കൾ അവയുടെ സ്ഥാനവും ഉൾപ്പെടുത്തി (മലയാളത്തിൽ).
ഉത്തരം മലയാളത്തിൽ മാത്രം നൽകുക.`
  }
  if (language === 'hi') {
    return `दृश्य विश्लेषण करें:
HAZARDS: खतरे, या "NONE".
DESCRIPTION: दृश्य का एक वाक्य विवरण, स्थानों के साथ (50 शब्दों से कम), केवल देवनागरी लिपि में हिंदी में.
OBJECTS: दिखने वाली वस्तुएं और उनके स्थान (हिंदी में).
उत्तर केवल हिंदी में दें।`
  }
  return `Analyze this scene for a visually impaired person.
HAZARDS: comma-separated list of immediate hazards, or "NONE" if none.
DESCRIPTION: one clear sentence describing what is ahead, with positions such as left, right, centre, near or far (under 50 words).
OBJECTS: comma-separated list of objects with their position, for example "door ahead, chair left".
Respond in English only. Format exactly as shown above.`;
}

/** The parser reads the labelled answer. It lives in its own module. */

/** Compresses a webcam frame and returns the base64 payload for the API. */
export async function prepareImageForApi(base64Image: string): Promise<string> {
  if (!base64Image || !base64Image.includes('base64')) {
    throw new Error('Invalid image data provided');
  }
  const imageData = base64Image.split(',')[1];
  if (!imageData) {
    throw new Error('Invalid base64 image format');
  }
  // Compress before sending to reduce payload size and analysis time.
  const compressed = await compressImage(`data:image/jpeg;base64,${imageData}`);
  return compressed.split(',')[1] || imageData;
}

export async function analyzeImage(base64Image: string, language: string = 'en') {
  try {
    // Compress before sending to reduce payload size and analysis time.
    const compressedData = await prepareImageForApi(base64Image);

    // Single API call returns hazards, description, and objects together
    const result = await generateContentWithRotation([
      buildAnalysisPrompt('scene', language),
      { inlineData: { data: compressedData, mimeType: 'image/jpeg' } }
    ]);

    const parsed = parseAnalysisResponse(readResponseText(result.response), 'scene', language);
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
    // Compress before sending to reduce payload size and analysis time.
    const compressedData = await prepareImageForApi(base64Image);

    // Single API call returns hazards and navigation together
    const result = await generateContentWithRotation([
      buildAnalysisPrompt('navigation', language),
      { inlineData: { data: compressedData, mimeType: 'image/jpeg' } }
    ]);

    const parsed = parseAnalysisResponse(readResponseText(result.response), 'navigation', language);
    return {
      navigation: parsed.navigation,
      hazards: parsed.hazards,
    };
  } catch (error) {
    console.error('Error analyzing image for navigation:', error);
    throw error;
  }
}

/** One question and one answer from an earlier turn. */
export type ConversationTurn = {
  question: string;
  answer: string;
};

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ml: 'Malayalam',
  hi: 'Hindi',
};

function buildQuestionPrompt(
  question: string,
  language: string,
  history: ConversationTurn[],
  hasImage: boolean
): string {
  const languageName = LANGUAGE_NAMES[language] ?? 'English';
  const earlier = history.length
    ? history.map((turn) => `Q: ${turn.question}\nA: ${turn.answer}`).join('\n')
    : '(none)';

  const imageNote = hasImage
    ? 'The image shows what the person sees right now.'
    : 'No image is available. Answer from the earlier exchange only.';

  return `You are a visual assistant for a blind person. ${imageNote}
Answer in one short spoken sentence. Never guess. If the image does not show the answer, say "I cannot tell from the image."

Earlier exchange:
${earlier}

Answer in ${languageName} only.

Question: ${question}`;
}

/**
 * Answers a spoken question about what the user sees.
 *
 * The image is optional. A question without an image still gets an answer from
 * the earlier exchange.
 */
export async function askAboutScene(
  question: string,
  base64Image: string | null,
  language: string = 'en',
  history: ConversationTurn[] = []
): Promise<string> {
  const parts: GenerateContentInput = [
    buildQuestionPrompt(question, language, history, !!base64Image),
  ];

  if (base64Image) {
    const imageData = await prepareImageForApi(base64Image);
    parts.push({ inlineData: { data: imageData, mimeType: 'image/jpeg' } });
  }

  const result = await generateContentWithRotation(parts);
  const answer = readResponseText(result.response);
  if (!answer) {
    throw new Error('The model returned an empty answer');
  }
  return answer;
}
