/**
 * Backup and restore related type definitions
 */

import { ResolvedPath } from './game';

/**
 * Backup path configuration
 */
export interface BackupPath {
  folder_name: string;
  template: string;
  type: 'reg' | 'folder' | 'file';
  install_folder: string | null;
  source_path?: string;
  backup_size?: number;
  files?: BackupFileEntry[];
  excluded?: string[];
}

/**
 * Backup configuration for a game
 */
export interface BackupConfig {
  schema_version?: number;
  created_at?: string;
  title: string;
  zh_CN: string | null;
  zh_TW?: string | null;
  backup_total_size?: number;
  backup_paths: BackupPath[];
}

/**
 * File manifest entry stored inside backup_info.json
 */
export interface BackupFileEntry {
  relative_path: string;
  type: 'file' | 'directory';
  size: number;
  mtime_ms: number;
}

/**
 * Whether the current local save differs from the latest backup.
 */
export type BackupChangeStatus = 'new' | 'updated' | 'unchanged';

/**
 * Size warning emitted when a backup looks unexpectedly large.
 */
export interface BackupSizeWarning {
  type: 'large' | 'growth';
  current_size: number;
  reference_size: number;
}

/**
 * Backup validation result.
 */
export interface BackupValidationResult {
  valid: boolean;
  backup_path: string;
  checked_files: number;
  missing_files: number;
  errors: string[];
  warnings: string[];
}

/**
 * Backup information metadata
 */
export interface BackupInfo {
  wiki_page_id: string;
  title: string;
  zh_CN?: string | null;
  zh_TW?: string | null;
  platform: string[];
  backup_date: string;
  backup_size: number;
  resolved_paths: ResolvedPath[];
}

/**
 * Backup operation result
 */
export interface BackupResult {
  success: boolean;
  error?: string;
  wikiId?: string;
}

/**
 * Restore operation result
 */
export interface RestoreResult {
  success: boolean;
  error?: string;
  wikiId?: string;
  userAction?: 'overwrite' | 'skip' | 'cancel';
}

/**
 * Progress information for backup/restore operations
 */
export interface ProgressInfo {
  current: number;
  total: number;
  currentFile?: string;
  percentage?: number;
}
