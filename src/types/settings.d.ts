/**
 * Application settings type definitions
 */

/**
 * Supported languages
 */
export type Language = 'en_US' | 'zh_CN' | 'zh_TW';

/**
 * Application themes
 */
export type Theme = 'light' | 'dark';

/**
 * Application settings interface
 */
export interface AppSettings {
  language: Language;
  theme: Theme;
  backupPath: string;
  gameInstalls: string[] | 'uninitialized';
  maxBackups: number;
  autoAppUpdate: boolean;
  autoDbUpdate: boolean;
  autoBackupEnabled: boolean;
  autoBackupInterval: number;
  excludedBackupPatterns: string[];
  backupSizeWarningEnabled: boolean;
  backupSizeWarningThresholdMb: number;
  backupSizeWarningMultiplier: number;
  pinnedGames: string[];
  compressionEnabled?: boolean;
}

/**
 * Settings key type for type-safe updates
 */
export type SettingsKey = keyof AppSettings;

/**
 * Settings value type
 */
export type SettingsValue<K extends SettingsKey> = AppSettings[K];
