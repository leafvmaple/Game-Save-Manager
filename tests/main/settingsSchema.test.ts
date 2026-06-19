import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SETTINGS_SCHEMA_VERSION,
  createDefaultSettings,
  normalizeSettings,
} from '../../src/main/settingsSchema';

describe('settings schema', () => {
  const appDataPath = path.resolve('C:\\Users\\Player\\AppData\\Roaming');
  const defaultSettings = createDefaultSettings(appDataPath, 'en_US');

  it('fills missing settings with defaults and stamps the current schema version', () => {
    expect(normalizeSettings({}, defaultSettings)).toEqual(defaultSettings);
  });

  it('normalizes invalid values into safe settings', () => {
    const absoluteInstallPath = path.resolve('D:\\Games');
    const normalized = normalizeSettings({
      settingsSchemaVersion: 0,
      theme: 'neon',
      language: 'fr_FR',
      backupPath: 'relative/backups',
      maxBackups: -5,
      autoAppUpdate: 'yes',
      autoDbUpdate: true,
      autoBackupEnabled: 'true',
      autoBackupInterval: 9999,
      excludedBackupPatterns: [' ', 'remotecache.vdf', 'x'.repeat(501), 42],
      backupSizeWarningEnabled: false,
      backupSizeWarningThresholdMb: 0,
      backupSizeWarningMultiplier: 200,
      gameInstalls: [absoluteInstallPath, 123, 'relative-game-path'],
      pinnedGames: ['safe_id-1', 'unsafe/id', 'alsoSafe_2'],
      unknownSetting: 'dropped',
    }, defaultSettings);

    expect(normalized).toEqual({
      ...defaultSettings,
      settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
      maxBackups: 1,
      autoDbUpdate: true,
      autoBackupInterval: 1440,
      excludedBackupPatterns: ['remotecache.vdf', '42'],
      backupSizeWarningEnabled: false,
      backupSizeWarningThresholdMb: 1,
      backupSizeWarningMultiplier: 100,
      gameInstalls: [absoluteInstallPath],
      pinnedGames: ['safe_id-1', 'alsoSafe_2'],
    });
    expect('unknownSetting' in normalized).toBe(false);
  });

  it('migrates legacy string lists and single install paths', () => {
    const installPath = path.resolve('D:\\SteamLibrary');
    const normalized = normalizeSettings({
      excludedBackupPatterns: 'cache\n*.tmp,remotecache.vdf',
      gameInstalls: installPath,
    }, defaultSettings);

    expect(normalized.excludedBackupPatterns).toEqual(['cache', '*.tmp', 'remotecache.vdf']);
    expect(normalized.gameInstalls).toEqual([installPath]);
  });
});
