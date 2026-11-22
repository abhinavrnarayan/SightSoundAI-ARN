// Reads the labelled answer from the Gemini model.
//
// The model often puts the value on the line after the label, or wraps a long
// value over several lines. Both cases keep their text here.

/** The labels the model must use. */
const ANALYSIS_LABELS = ['HAZARDS', 'DESCRIPTION', 'OBJECTS', 'NAVIGATION'] as const;

type AnalysisLabel = (typeof ANALYSIS_LABELS)[number];

// Helper function to translate hazards to Malayalam and Hindi
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

const translateHazardsToLanguage = (hazards: string[], language: string): string[] => {
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

export type ParsedAnalysis = {
  hazards: string[];
  description: string;
  objects: string[];
  navigation: string;
};

/** Reads the labelled answer from the model. */
export function parseAnalysisResponse(
  text: string,
  mode: 'scene' | 'navigation',
  language: string
): ParsedAnalysis {
  const values: Record<AnalysisLabel, string[]> = {
    HAZARDS: [],
    DESCRIPTION: [],
    OBJECTS: [],
    NAVIGATION: [],
  };
  let current: AnalysisLabel | null = null;
  let foundLabel = false;

  for (const raw of text.split('\n')) {
    // The model sometimes adds markdown around a label.
    const line = raw.replace(/[*_#]/g, '').trim();
    if (!line) continue;

    const match = /^([A-Z][A-Z ]*)\s*:\s*(.*)$/.exec(line);
    const label = match ? match[1].trim() : '';
    if (label && (ANALYSIS_LABELS as readonly string[]).includes(label)) {
      current = label as AnalysisLabel;
      foundLabel = true;
      const value = match![2].trim();
      if (value) values[current].push(value);
      continue;
    }

    // A line without a label belongs to the label above it.
    if (current) values[current].push(line);
  }

  const description = values.DESCRIPTION.join(' ').trim();
  const navigation = values.NAVIGATION.join(' ').trim();
  const hazardsText = values.HAZARDS.join(' ').trim();

  // An answer without any label still gives usable text.
  const fallback = foundLabel ? '' : text.replace(/\s+/g, ' ').trim();

  const hazardList = /^none\b/i.test(hazardsText)
    ? []
    : values.HAZARDS.flatMap((line) => line.split(','))
        .map((h) => h.trim())
        .filter(Boolean);

  const objectList = values.OBJECTS.flatMap((line) => line.split(','))
    .map((o) => o.trim())
    .filter(Boolean);

  return {
    hazards:
      language === 'en'
        ? hazardList
        : translateHazardsToLanguage(hazardList, language),
    description: description || (mode === 'scene' ? fallback : ''),
    objects: objectList,
    navigation: navigation || (mode === 'navigation' ? fallback : ''),
  };
}
