/**
 * Game-related type definitions
 */

/**
 * Game platform identifiers
 */
export type GamePlatform = 'Custom' | 'Steam' | 'Ubisoft' | 'EA' | 'Epic' | 'GOG' | 'Xbox' | 'Blizzard';

/**
 * Game save location paths for different operating systems
 */
export interface SaveLocation {
  win: string[];
  reg: string[];
  mac: string[];
  linux: string[];
  [key: string]: string[]; // Allow indexing with string keys
}

/**
 * Resolved path information
 */
export interface ResolvedPath {
  template: string;
  resolved: string;
  uid?: string;
  type?: 'reg' | 'folder' | 'file';
}

/**
 * Complete game information
 */
export interface Game {
  title: string;
  wiki_page_id: string;
  install_folder: string;
  steam_id?: number;
  gog_id?: number;
  save_location: SaveLocation;
  platform: GamePlatform[];
  zh_CN?: string | null;
  zh_TW?: string | null;
  install_path: string;
  latest_backup: string;
  resolved_paths: ResolvedPath[];
  backup_size: number;
}

/**
 * Game data tracking platform installations and user IDs
 */
export interface GameData {
  steamPath: string | null;
  ubisoftPath: string | null;
  eaPath: string | null;
  battleNetPath: string | null;
  currentSteamUserId64: string | null;
  currentSteamUserId3: string | null;
  currentSteamAccountName: string | null;
  currentSteamUserName: string | null;
  currentUbisoftUserId: string | null;
  detectedGamePaths: string[];
  detectedSteamGameIds: string[];
}

/**
 * Icon mapping for different platforms
 */
export interface IconMap {
  [key: string]: string;
}
