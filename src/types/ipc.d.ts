/**
 * IPC (Inter-Process Communication) type definitions
 * Types for communication between main and renderer processes
 */

import { Game } from './game';
import { BackupValidationResult, RestoreResult } from './backup';
import { AppSettings, SettingsKey, SettingsValue } from './settings';
import { AppStatus } from './common';

type RendererStatusKey = Exclude<keyof AppStatus, 'auto_backuping'>;

/**
 * IPC channel names
 */
export type IpcChannel =
  | 'translate'
  | 'save-settings'
  | 'load-theme'
  | 'get-settings'
  | 'get-detected-game-paths'
  | 'open-url'
  | 'open-backup-folder'
  | 'open-backup-dialog'
  | 'open-dialog'
  | 'select-path'
  | 'get-newest-backup-time'
  | 'sort-games'
  | 'save-custom-entries'
  | 'load-custom-entries'
  | 'get-platform'
  | 'get-uuid'
  | 'get-icon-map'
  | 'fetch-backup-table-data'
  | 'backup-game'
  | 'fetch-restore-table-data'
  | 'restore-game'
  | 'validate-backup'
  | 'migrate-backups'
  | 'get-status'
  | 'update-status'
  | 'get-current-version'
  | 'get-latest-version'
  | 'update-database';

/**
 * IPC event channel names (one-way communication)
 */
export type IpcEventChannel =
  | 'update-backup-table'
  | 'update-restore-table'
  | 'show-alert'
  | 'apply-theme'
  | 'apply-language'
  | 'update-progress';

/**
 * IPC API exposed to renderer process
 */
export interface IpcApi {
  // Invoke methods (request-response)
  invoke(channel: 'translate', key: string, options?: any): Promise<string>;
  invoke(channel: 'get-settings'): Promise<AppSettings>;
  invoke(channel: 'get-detected-game-paths'): Promise<string[]>;
  invoke(channel: 'open-url', url: string): Promise<void>;
  invoke(channel: 'open-backup-folder', wikiId: string): Promise<void>;
  invoke(channel: 'open-backup-dialog'): Promise<string | null>;
  invoke(channel: 'open-dialog'): Promise<any>;
  invoke(channel: 'select-path', fileType: 'file' | 'folder' | 'registry'): Promise<string | null>;
  invoke(channel: 'get-newest-backup-time', wikiPageId: string): Promise<string>;
  invoke(channel: 'sort-games', games: any[]): Promise<any[]>;
  invoke(channel: 'save-custom-entries', jsonObj: any): Promise<void>;
  invoke(channel: 'load-custom-entries'): Promise<any[]>;
  invoke(channel: 'get-platform'): Promise<string>;
  invoke(channel: 'get-uuid'): Promise<string>;
  invoke(channel: 'get-icon-map'): Promise<{ [key: string]: string }>;
  invoke(channel: 'fetch-backup-table-data'): Promise<Game[]>;
  invoke(channel: 'backup-game', gameObj: any): Promise<string | null>;
  invoke(channel: 'fetch-restore-table-data'): Promise<Game[]>;
  invoke(channel: 'restore-game', gameObj: any, userActionForAll: any): Promise<RestoreResult>;
  invoke(channel: 'validate-backup', gameObj: any): Promise<BackupValidationResult>;
  invoke(channel: 'get-status'): Promise<AppStatus>;
  invoke(channel: 'get-current-version'): Promise<string>;
  invoke(channel: 'get-latest-version'): Promise<string | null>;
  invoke(channel: 'update-database'): Promise<void>;

  // Send methods (one-way)
  send(channel: 'save-settings', key: SettingsKey, value: any): void;
  send(channel: 'load-theme'): void;
  send(channel: 'migrate-backups', newBackupPath: string): void;
  send(channel: 'update-status', statusKey: RendererStatusKey, statusValue: boolean): void;

  // Receive methods (listen to events from main process)
  receive(channel: IpcEventChannel, callback: (...args: any[]) => void): void;
}

/**
 * Window API exposed to renderer process
 */
declare global {
  interface Window {
    api: IpcApi;
  }
}
