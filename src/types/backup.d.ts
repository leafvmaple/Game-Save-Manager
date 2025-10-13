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
}

/**
 * Backup configuration for a game
 */
export interface BackupConfig {
  title: string;
  zh_CN: string | null;
  zh_TW?: string | null;
  backup_paths: BackupPath[];
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
