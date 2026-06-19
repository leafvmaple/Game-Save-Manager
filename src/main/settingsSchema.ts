import path from 'path';

import type { AppSettings, Language, Theme } from '../types/settings';

const SETTINGS_SCHEMA_VERSION = 1;

const MIN_AUTO_BACKUP_INTERVAL_MINUTES = 5;
const MAX_AUTO_BACKUP_INTERVAL_MINUTES = 1440;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const createDefaultSettings = (appDataPath: string, detectedLanguage: Language): AppSettings => ({
  settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
  theme: 'dark',
  language: detectedLanguage,
  backupPath: path.join(appDataPath, 'GSM Backups'),
  maxBackups: 5,
  autoAppUpdate: true,
  autoDbUpdate: false,
  autoBackupEnabled: false,
  autoBackupInterval: 30,
  excludedBackupPatterns: [],
  backupSizeWarningEnabled: true,
  backupSizeWarningThresholdMb: 1024,
  backupSizeWarningMultiplier: 3,
  gameInstalls: 'uninitialized',
  pinnedGames: [],
});

const normalizeSettings = (rawSettings: unknown, defaultSettings: AppSettings): AppSettings => {
  const source = migrateSettings(isRecord(rawSettings) ? rawSettings : {});
  const settings: AppSettings = {
    settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
    theme: normalizeTheme(source.theme, defaultSettings.theme),
    language: normalizeLanguage(source.language, defaultSettings.language),
    backupPath: normalizeAbsolutePath(source.backupPath, defaultSettings.backupPath),
    maxBackups: normalizeInteger(source.maxBackups, defaultSettings.maxBackups, 1, 1000),
    autoAppUpdate: normalizeBoolean(source.autoAppUpdate, defaultSettings.autoAppUpdate),
    autoDbUpdate: normalizeBoolean(source.autoDbUpdate, defaultSettings.autoDbUpdate),
    autoBackupEnabled: normalizeBoolean(source.autoBackupEnabled, defaultSettings.autoBackupEnabled),
    autoBackupInterval: normalizeInteger(
      source.autoBackupInterval,
      defaultSettings.autoBackupInterval,
      MIN_AUTO_BACKUP_INTERVAL_MINUTES,
      MAX_AUTO_BACKUP_INTERVAL_MINUTES
    ),
    excludedBackupPatterns: normalizeStringList(source.excludedBackupPatterns, 200, 500),
    backupSizeWarningEnabled: normalizeBoolean(source.backupSizeWarningEnabled, defaultSettings.backupSizeWarningEnabled),
    backupSizeWarningThresholdMb: normalizeInteger(
      source.backupSizeWarningThresholdMb,
      defaultSettings.backupSizeWarningThresholdMb,
      1,
      102400
    ),
    backupSizeWarningMultiplier: normalizeNumber(
      source.backupSizeWarningMultiplier,
      defaultSettings.backupSizeWarningMultiplier,
      1,
      100
    ),
    gameInstalls: normalizeGameInstalls(source.gameInstalls, defaultSettings.gameInstalls),
    pinnedGames: normalizeSafeIdList(source.pinnedGames),
  };

  if (typeof source.compressionEnabled === 'boolean') {
    settings.compressionEnabled = source.compressionEnabled;
  } else if (typeof defaultSettings.compressionEnabled === 'boolean') {
    settings.compressionEnabled = defaultSettings.compressionEnabled;
  }

  return settings;
};

const migrateSettings = (source: Record<string, unknown>): Record<string, unknown> => {
  const migrated = { ...source };

  if (typeof migrated.excludedBackupPatterns === 'string') {
    migrated.excludedBackupPatterns = migrated.excludedBackupPatterns
      .split(/\r?\n|,/)
      .map(pattern => pattern.trim());
  }

  if (typeof migrated.gameInstalls === 'string' && migrated.gameInstalls !== 'uninitialized') {
    migrated.gameInstalls = [migrated.gameInstalls];
  }

  return migrated;
};

const normalizeTheme = (value: unknown, fallback: Theme): Theme => {
  return value === 'light' || value === 'dark' ? value : fallback;
};

const normalizeLanguage = (value: unknown, fallback: Language): Language => {
  return value === 'en_US' || value === 'zh_CN' || value === 'zh_TW' ? value : fallback;
};

const normalizeAbsolutePath = (value: unknown, fallback: string): string => {
  return typeof value === 'string' && path.isAbsolute(value) ? value : fallback;
};

const normalizeBoolean = (value: unknown, fallback: boolean): boolean => {
  return typeof value === 'boolean' ? value : fallback;
};

const normalizeInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
};

const normalizeNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
};

const normalizeStringList = (value: unknown, maxItems: number, maxLength: number): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(item => String(item).trim())
    .filter(item => item.length > 0 && item.length <= maxLength)
    .slice(0, maxItems);
};

const normalizeSafeIdList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(String)
    .filter(item => /^[a-zA-Z0-9_-]+$/.test(item));
};

const normalizeGameInstalls = (
  value: unknown,
  fallback: AppSettings['gameInstalls']
): AppSettings['gameInstalls'] => {
  if (value === 'uninitialized') {
    return value;
  }

  if (!Array.isArray(value)) {
    return fallback;
  }

  return value
    .filter(item => typeof item === 'string' && path.isAbsolute(item));
};

export {
  SETTINGS_SCHEMA_VERSION,
  createDefaultSettings,
  normalizeSettings,
};
