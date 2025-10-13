/**
 * Platform-specific type definitions
 */

/**
 * Windows Registry hive constants
 */
export type RegistryHive = 
  | 'HKEY_CURRENT_USER'
  | 'HKEY_LOCAL_MACHINE'
  | 'HKEY_CLASSES_ROOT'
  | 'HKEY_USERS'
  | 'HKEY_CURRENT_CONFIG';

/**
 * Registry path parsing result
 */
export interface RegistryPathInfo {
  hive: string;
  key: string;
}

/**
 * Steam library folder structure
 */
export interface SteamLibraryFolder {
  path?: string;
  apps?: {
    [appId: string]: any;
  };
}

/**
 * Steam library folders VDF structure
 */
export interface SteamLibraryFolders {
  libraryfolders: {
    [key: string]: SteamLibraryFolder;
  };
}

/**
 * Steam user data structure
 */
export interface SteamUserData {
  [userId64: string]: {
    AccountName: string;
    PersonaName: string;
    MostRecent: number;
  };
}

/**
 * Steam users VDF structure
 */
export interface SteamLoginUsers {
  users: SteamUserData;
}

/**
 * Steam local config structure
 */
export interface SteamLocalConfig {
  UserLocalConfigStore?: {
    friends?: {
      PersonaName?: string;
    };
  };
}

/**
 * Ubisoft settings YAML structure
 */
export interface UbisoftSettings {
  misc: {
    game_installation_path: string;
  };
}

/**
 * Battle.net config structure
 */
export interface BattleNetConfig {
  Client: {
    Install: {
      DefaultInstallPath: string;
    };
  };
}

/**
 * Path resolution result with optional user ID
 */
export interface PathResolutionResult {
  path: string;
  uid?: string;
}
