import { initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import { getAnalytics, isSupported, type Analytics, logEvent, setUserProperties, setUserId } from 'firebase/analytics';

const STORAGE_KEYS = {
  deviceId: 'sightsound_device_id',
  hasVisited: 'sightsound_has_visited',
  visitCount: 'sightsound_visit_count',
  sessionHistory: 'sightsound_session_history', // JSON number[] of session start timestamps
} as const;

function getFirebaseConfig(): FirebaseOptions | null {
  const {
    VITE_FIREBASE_API_KEY,
    VITE_FIREBASE_AUTH_DOMAIN,
    VITE_FIREBASE_PROJECT_ID,
    VITE_FIREBASE_STORAGE_BUCKET,
    VITE_FIREBASE_MESSAGING_SENDER_ID,
    VITE_FIREBASE_APP_ID,
    VITE_FIREBASE_MEASUREMENT_ID,
  } = import.meta.env;

  // Only enable Firebase/Analytics when configured
  if (!VITE_FIREBASE_API_KEY || !VITE_FIREBASE_AUTH_DOMAIN || !VITE_FIREBASE_PROJECT_ID || !VITE_FIREBASE_APP_ID) {
    return null;
  }

  return {
    apiKey: VITE_FIREBASE_API_KEY,
    authDomain: VITE_FIREBASE_AUTH_DOMAIN,
    projectId: VITE_FIREBASE_PROJECT_ID,
    storageBucket: VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: VITE_FIREBASE_APP_ID,
    measurementId: VITE_FIREBASE_MEASUREMENT_ID,
  };
}

let analyticsPromise: Promise<Analytics | null> | null = null;
let analyticsInstance: Analytics | null = null;
let firebaseApp: FirebaseApp | null = null;
let sessionStartTime: number = Date.now();
let sessionId: string = '';
let deviceId: string = '';
let visitCount: number = 0;
let isReturningUser: boolean = false;
let isRegularUser: boolean = false;

function randomId(prefix: string): string {
  // Avoid crypto dependency issues; use when available for better uniqueness.
  const uuid = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : null;
  if (uuid) return `${prefix}_${uuid}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

// Persistent ID per browser+device (not a cross-device person identity).
function getOrCreateDeviceId(): string {
  let id = localStorage.getItem(STORAGE_KEYS.deviceId);
  if (!id) {
    id = randomId('device');
    localStorage.setItem(STORAGE_KEYS.deviceId, id);
  }
  return id;
}

// Generate session ID
function generateSessionId(): string {
  return randomId('session');
}

// Detect browser
function detectBrowser(): string {
  const ua = navigator.userAgent;
  if (ua.includes('Chrome') && !ua.includes('Edg') && !ua.includes('OPR')) return 'Chrome';
  if (ua.includes('Firefox')) return 'Firefox';
  if (ua.includes('Safari') && !ua.includes('Chrome')) return 'Safari';
  if (ua.includes('Edg')) return 'Edge';
  if (ua.includes('OPR')) return 'Opera';
  return 'Other';
}

// Detect operating system
function detectOS(): string {
  const ua = navigator.userAgent;
  if (ua.includes('Windows')) return 'Windows';
  if (ua.includes('Mac')) return 'macOS';
  if (ua.includes('Linux')) return 'Linux';
  if (ua.includes('Android')) return 'Android';
  if (ua.includes('iOS') || ua.includes('iPhone') || ua.includes('iPad')) return 'iOS';
  return 'Unknown';
}

// Detect device type
function detectDeviceType(): string {
  const ua = navigator.userAgent;
  if (/Mobile|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) {
    if (/Tablet|iPad/i.test(ua)) return 'Tablet';
    return 'Mobile';
  }
  return 'Desktop';
}

// Get connection type
type NetworkInformation = {
  effectiveType?: string;
  type?: string;
};

type NavigatorWithConnection = Navigator & {
  connection?: NetworkInformation;
  mozConnection?: NetworkInformation;
  webkitConnection?: NetworkInformation;
};

function getConnectionType(): string {
  const nav = navigator as NavigatorWithConnection;
  const connection = nav.connection || nav.mozConnection || nav.webkitConnection;
  return connection?.effectiveType || connection?.type || 'unknown';
}

// Context to attach as event params (GA4 already collects many of these automatically,
// but including them can help with custom event analysis / BigQuery export).
function getDeviceContext() {
  const screen = window.screen;
  const connection = getConnectionType();
  
  return {
    browser: detectBrowser(),
    browser_version: navigator.userAgent.match(/(?:Chrome|Firefox|Safari|Edg|OPR)\/(\d+)/)?.[1] || 'unknown',
    os: detectOS(),
    device_type: detectDeviceType(),
    screen_width: screen.width,
    screen_height: screen.height,
    viewport_width: window.innerWidth,
    viewport_height: window.innerHeight,
    pixel_ratio: window.devicePixelRatio || 1,
    connection_type: connection,
    language: navigator.language || 'unknown',
    languages: navigator.languages?.join(',') || navigator.language || 'unknown',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    platform: navigator.platform,
    cookie_enabled: navigator.cookieEnabled ? 1 : 0,
    online_status: navigator.onLine ? 'online' : 'offline',
    hardware_concurrency: navigator.hardwareConcurrency || 0,
    max_touch_points: navigator.maxTouchPoints || 0,
  };
}

function readSessionHistory(): number[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.sessionHistory);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  } catch {
    return [];
  }
}

function writeSessionHistory(timestamps: number[]) {
  try {
    localStorage.setItem(STORAGE_KEYS.sessionHistory, JSON.stringify(timestamps));
  } catch {
    // Ignore storage issues (private mode / quota)
  }
}

function computeUserClassification(nextVisitCount: number, sessionHistory: number[]) {
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const sessionsLast7d = sessionHistory.filter((t) => t >= now - sevenDaysMs).length;

  return {
    is_returning: nextVisitCount >= 2,
    // Define "regular" as either frequent recent sessions OR higher lifetime visits.
    is_regular: sessionsLast7d >= 3 || nextVisitCount >= 5,
    sessions_last_7d: sessionsLast7d,
  };
}

// Session metrics (kept lightweight; avoid precise geolocation here)
function getSessionContext() {
  return {
    session_start_time: new Date(sessionStartTime).toISOString(),
    session_duration: Math.floor((Date.now() - sessionStartTime) / 1000), // in seconds
    page_load_time: performance.timing ? Math.round(performance.timing.loadEventEnd - performance.timing.navigationStart) : 0,
    dom_content_loaded: performance.timing ? Math.round(performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart) : 0,
  };
}

// Initialize Analytics only in the browser and when supported
export function initAnalytics(): Promise<Analytics | null> {
  if (analyticsPromise) return analyticsPromise;
  analyticsPromise = (async () => {
    if (typeof window === 'undefined') return null;

    const firebaseConfig = getFirebaseConfig();
    if (!firebaseConfig) return null;

    const supported = await isSupported().catch(() => false);
    if (!supported) return null;
    try {
      if (!firebaseApp) {
        firebaseApp = initializeApp(firebaseConfig);
      }

      analyticsInstance = getAnalytics(firebaseApp);
      
      // Generate persistent device ID and a new session
      deviceId = getOrCreateDeviceId();
      sessionId = generateSessionId();
      sessionStartTime = Date.now();
      
      // Mark session in local history (for "regular user" classification)
      const history = readSessionHistory();
      history.push(sessionStartTime);
      // Keep last ~60 entries to avoid unbounded growth
      const trimmed = history.slice(-60);
      writeSessionHistory(trimmed);

      // Visits: increment once per session start
      const prevVisitCount = parseInt(localStorage.getItem(STORAGE_KEYS.visitCount) || '0', 10) || 0;
      visitCount = prevVisitCount + 1;
      localStorage.setItem(STORAGE_KEYS.hasVisited, 'true');
      localStorage.setItem(STORAGE_KEYS.visitCount, String(visitCount));

      const { is_returning, is_regular, sessions_last_7d } = computeUserClassification(visitCount, trimmed);
      isReturningUser = is_returning;
      isRegularUser = is_regular;

      // Use GA4 user_id as a stable pseudonymous device ID (not PII).
      setUserId(analyticsInstance, deviceId);
      
      const deviceContext = getDeviceContext();
      const sessionContext = getSessionContext();
      
      // Keep user properties minimal (GA4 has limits). Prefer event params for rich context.
      setUserProperties(analyticsInstance, {
        device_id: deviceId,
        device_type: deviceContext.device_type,
        is_returning: String(is_returning),
        is_regular: String(is_regular),
        visit_count: String(visitCount),
      });
      
      // Track page view (GA4 will also auto-collect page_view)
      logEvent(analyticsInstance, 'page_view', {
        session_id: sessionId,
        page_title: document.title,
        page_location: window.location.href,
        device_id: deviceId,
        visit_count: visitCount,
        is_returning,
        is_regular,
        sessions_last_7d,
        ...deviceContext,
        ...sessionContext,
      });
      
      return analyticsInstance;
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error('Analytics initialization failed:', error);
      }
      return null;
    }
  })();
  return analyticsPromise;
}

export async function getAnalyticsInstance(): Promise<Analytics | null> {
  if (analyticsInstance) return analyticsInstance;
  return initAnalytics();
}

// Helper function to track events safely with enhanced context
export type AnalyticsEventParams = Record<string, unknown>;

export async function trackEvent(
  eventName: string,
  eventParams?: AnalyticsEventParams
): Promise<void> {
  try {
    const analytics = await getAnalyticsInstance();
    if (analytics) {
      const deviceContext = getDeviceContext();
      const sessionContext = getSessionContext();

      // Add common context to all events (avoid precise location here)
      const enhancedParams: AnalyticsEventParams = {
        ...(eventParams ?? {}),
        session_id: sessionId,
        device_id: deviceId,
        visit_count: visitCount,
        is_returning: isReturningUser ? 1 : 0,
        is_regular: isRegularUser ? 1 : 0,
        ...deviceContext,
        ...sessionContext,
        timestamp: new Date().toISOString(),
      };
      
      logEvent(analytics, eventName, enhancedParams);
    }
  } catch (error) {
    // Silently fail in production, log in dev
    if (import.meta.env.DEV) {
      console.warn('Analytics event failed:', eventName, error);
    }
  }
}

// Track user engagement (time spent, interactions)
export async function trackEngagement(action: string, details?: AnalyticsEventParams): Promise<void> {
  await trackEvent('user_engagement', {
    engagement_action: action,
    ...details,
    session_duration: Math.floor((Date.now() - sessionStartTime) / 1000),
  });
}

// Track performance metrics
export async function trackPerformance(metricName: string, value: number, unit: string = 'ms'): Promise<void> {
  await trackEvent('performance_metric', {
    metric_name: metricName,
    metric_value: value,
    metric_unit: unit,
  });
}

// Track errors
export async function trackError(error: Error | string, context?: AnalyticsEventParams): Promise<void> {
  const errorMessage = typeof error === 'string' ? error : error.message;
  const errorStack = typeof error === 'string' ? '' : error.stack;
  
  await trackEvent('error_occurred', {
    error_message: errorMessage,
    error_stack: errorStack?.substring(0, 500), // Limit stack trace length
    ...context,
  });
}

// Get current session info
export function getSessionInfo() {
  return {
    sessionId,
    deviceId,
    sessionStartTime,
    sessionDuration: Math.floor((Date.now() - sessionStartTime) / 1000),
    visitCount,
    isReturningUser,
    isRegularUser,
  };
}

// Helper function to update user properties
export async function updateUserProperties(properties: AnalyticsEventParams): Promise<void> {
  try {
    const analytics = await getAnalyticsInstance();
    if (analytics) {
      setUserProperties(analytics, {
        device_id: deviceId,
        ...properties,
        last_updated: new Date().toISOString(),
      });
    }
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('Analytics user properties update failed:', error);
    }
  }
}


