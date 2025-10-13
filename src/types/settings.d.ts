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
export type Theme = 'light' | 'dark' | 'auto';

/**
 * Application settings interface
 */
export interface AppSettings {
  language: Language;
  theme: Theme;
  backupPath: string;
  gameInstalls: string[] | 'uninitialized';
  maxBackupCount: number;
  autoAppUpdate: boolean;
  pinnedGames: string[];
  compressionEnabled?: boolean;
  autoBackupEnabled?: boolean;
  autoBackupInterval?: number; // in minutes
}

/**
 * Settings key type for type-safe updates
 */
export type SettingsKey = keyof AppSettings;

/**
 * Settings value type
 */
export type SettingsValue<K extends SettingsKey> = AppSettings[K];
