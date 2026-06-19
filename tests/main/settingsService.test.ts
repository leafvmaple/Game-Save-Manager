import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appDataPath: '',
  locale: 'en-US',
  userDataPath: '',
}));

vi.mock('electron', () => ({
  app: {
    getLocale: vi.fn(() => mocks.locale),
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return mocks.userDataPath;
      if (name === 'appData') return mocks.appDataPath;
      return mocks.userDataPath;
    }),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock('i18next', () => ({
  default: {
    changeLanguage: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('../../src/main/windowManager', () => ({
  getMainWindow: vi.fn(() => null),
  rebuildApplicationMenu: vi.fn(),
}));

import { SETTINGS_SCHEMA_VERSION } from '../../src/main/settingsSchema';
import { getSettings, loadSettings } from '../../src/main/settingsService';

describe('settings service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-settings-'));
    mocks.userDataPath = path.join(tempDir, 'UserData');
    mocks.appDataPath = path.join(tempDir, 'AppData');
    mocks.locale = 'zh-Hans-CN';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates default settings when the file is missing', () => {
    loadSettings();

    const settings = getSettings();
    expect(settings).toMatchObject({
      settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
      language: 'zh_CN',
      theme: 'dark',
      backupPath: path.join(mocks.appDataPath, 'GSM Backups'),
      gameInstalls: 'uninitialized',
    });
    expect(JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'))).toEqual(settings);
  });

  it('falls back to defaults when settings JSON is malformed', () => {
    fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true });
    fs.writeFileSync(getSettingsPath(), '{ malformed json');

    loadSettings();

    expect(getSettings().settingsSchemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(getSettings().backupPath).toBe(path.join(mocks.appDataPath, 'GSM Backups'));
    expect(JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'))).toEqual(getSettings());
  });

  it('normalizes persisted settings and writes the migrated version back', () => {
    const installPath = path.join(tempDir, 'Library');
    fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true });
    fs.writeFileSync(getSettingsPath(), JSON.stringify({
      theme: 'blue',
      language: 'zh_TW',
      backupPath: 'relative',
      maxBackups: 2000,
      autoBackupInterval: 1,
      gameInstalls: [installPath, 'relative'],
      pinnedGames: ['ok_id', '../bad'],
    }));

    loadSettings();

    expect(getSettings()).toMatchObject({
      settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
      theme: 'dark',
      language: 'zh_TW',
      backupPath: path.join(mocks.appDataPath, 'GSM Backups'),
      maxBackups: 1000,
      autoBackupInterval: 5,
      gameInstalls: [installPath],
      pinnedGames: ['ok_id'],
    });
    expect(JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'))).toEqual(getSettings());
  });

  function getSettingsPath(): string {
    return path.join(mocks.userDataPath, 'GSM Settings', 'settings.json');
  }
});
