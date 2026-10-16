export interface AppConfig {
  readonly apiBaseUrl: string;
  readonly maxRevision: number;
  readonly sseReconnectDelayMs: number;
  readonly maxAttachments: number;
}

export function loadAppConfig(
  env: Record<string, string | undefined> = import.meta.env ?? {},
): AppConfig {
  const rawMaxRev = env.VITE_MAX_REVISION;
  const parsedMaxRev = rawMaxRev ? Number.parseInt(rawMaxRev, 10) : 3;
  const maxRevision = Number.isNaN(parsedMaxRev) || parsedMaxRev < 1 ? 3 : parsedMaxRev;

  const rawReconnect = env.VITE_SSE_RECONNECT_MS;
  const parsedReconnect = rawReconnect ? Number.parseInt(rawReconnect, 10) : 1500;
  const sseReconnectDelayMs =
    Number.isNaN(parsedReconnect) || parsedReconnect < 100 ? 1500 : parsedReconnect;

  return {
    apiBaseUrl: env.VITE_API_BASE_URL ?? "/api",
    maxRevision,
    sseReconnectDelayMs,
    maxAttachments: 3,
  };
}

export const appConfig: AppConfig = loadAppConfig();
