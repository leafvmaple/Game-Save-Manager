/**
 * Common types used across the application
 */

/**
 * Map of OS-specific placeholders to their actual paths
 */
export interface PlaceholderMapping {
  [key: string]: string;
}

/**
 * OS platform identifiers
 */
export type OsPlatform = 'win' | 'mac' | 'linux';

/**
 * OS key mapping
 */
export interface OsKeyMap {
  [key: string]: OsPlatform;
}

/**
 * Application status tracking
 */
export interface AppStatus {
  isBackingUp: boolean;
  isRestoring: boolean;
  isMigrating: boolean;
  isUpdatingDb: boolean;
}

/**
 * Notification types
 */
export type NotificationType = 'info' | 'warning' | 'critical';

/**
 * Alert types for UI
 */
export type AlertType = 'success' | 'warning' | 'modal' | 'error';
