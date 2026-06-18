import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: {
    backupPath: '',
    gameInstalls: [] as string[],
  },
  gameData: {
    steamPath: '',
    ubisoftPath: '',
  },
  showMessageBox: vi.fn(),
  focusedWindow: {},
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => mocks.focusedWindow),
  },
  dialog: {
    showMessageBox: mocks.showMessageBox,
  },
}));

vi.mock('original-fs', async () => {
  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actualFs, default: actualFs };
});

vi.mock('../../src/main/gameData', () => ({
  getGameData: () => mocks.gameData,
}));

vi.mock('../../src/main/global', () => ({
  calculateDirectorySize: vi.fn(),
  copyFolder: vi.fn(),
  ensureWritable: vi.fn(),
  getGameDisplayName: vi.fn((game: { title?: string }) => game.title || 'Unknown Game'),
  getSettings: () => mocks.settings,
  placeholderMapping: {
    '{{p|username}}': 'Player',
    '{{p|userprofile}}': 'C:\\Users\\Player',
    '{{p|appdata}}': 'C:\\Users\\Player\\AppData\\Roaming',
    '{{p|localappdata}}': 'C:\\Users\\Player\\AppData\\Local',
  },
}));

vi.mock('i18next', () => ({
  default: {
    t: vi.fn((key: string, options?: Record<string, unknown>) => {
      if (options?.game) return `${key}:${options.game}`;
      return key;
    }),
  },
}));

import {
  getGameInstallPath,
  getLatestModificationTime,
  resolveTemplatedRestorePath,
  shouldSkip,
} from '../../src/main/restore';

describe('restore helpers', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-restore-'));
    mocks.settings.backupPath = path.join(tempDir, 'Backups');
    mocks.settings.gameInstalls = [path.join(tempDir, 'Library')];
    mocks.gameData.steamPath = path.join(tempDir, 'Steam');
    mocks.gameData.ubisoftPath = path.join(tempDir, 'Ubisoft Connect');
    mocks.showMessageBox.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns Date(0) for missing paths', () => {
    expect(getLatestModificationTime(path.join(tempDir, 'missing')).getTime()).toBe(0);
  });

  it('returns the newest modification time inside nested directories', () => {
    const root = path.join(tempDir, 'save-root');
    const nested = path.join(root, 'nested');
    const oldFile = path.join(root, 'old.dat');
    const newFile = path.join(nested, 'new.dat');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(oldFile, 'old');
    fs.writeFileSync(newFile, 'new');

    const oldTime = new Date('2024-01-01T01:02:03Z');
    const newTime = new Date('2024-02-03T04:05:06Z');
    fs.utimesSync(oldFile, oldTime, oldTime);
    fs.utimesSync(newFile, newTime, newTime);

    expect(getLatestModificationTime(root).getTime()).toBe(
      new Date('2024-02-03T04:05:00Z').getTime()
    );
  });

  it('finds the installed game folder for {{p|game}} restore paths', () => {
    const installedGame = path.join(mocks.settings.gameInstalls[0], 'Example Game');
    fs.mkdirSync(installedGame, { recursive: true });

    expect(getGameInstallPath('Example Game')).toBe(installedGame);
    expect(resolveTemplatedRestorePath('{{p|game}}\\Saves', 'Example Game'))
      .toBe(`${installedGame}\\Saves`);
  });

  it('returns gameNotInstalled when install paths are unavailable', () => {
    mocks.settings.gameInstalls = 'uninitialized' as unknown as string[];

    expect(getGameInstallPath('Example Game')).toBe('gameNotInstalled');
    expect(resolveTemplatedRestorePath('{{p|game}}\\Saves', 'Example Game'))
      .toBe('gameNotInstalled\\Saves');
  });

  it('resolves launcher and user placeholders for restore paths', () => {
    expect(resolveTemplatedRestorePath('{{p|steam}}\\userdata', ''))
      .toBe(`${mocks.gameData.steamPath}\\userdata`);
    expect(resolveTemplatedRestorePath('{{p|ubisoftconnect}}\\savegames', ''))
      .toBe(`${mocks.gameData.ubisoftPath}\\savegames`);
    expect(resolveTemplatedRestorePath('{{p|appdata}}\\Game', ''))
      .toBe('C:\\Users\\Player\\AppData\\Roaming\\Game');
  });

  it('does not prompt when backup data is newer than the local destination', async () => {
    const sourcePath = path.join(tempDir, 'backup.dat');
    const destinationPath = path.join(tempDir, 'local.dat');
    fs.writeFileSync(sourcePath, 'backup');
    fs.writeFileSync(destinationPath, 'local');
    fs.utimesSync(sourcePath, new Date('2024-03-01T00:00:00Z'), new Date('2024-03-01T00:00:00Z'));
    fs.utimesSync(destinationPath, new Date('2024-02-01T00:00:00Z'), new Date('2024-02-01T00:00:00Z'));

    await expect(shouldSkip([{ sourcePath, destinationPath }], 'Example Game', null)).resolves.toEqual({
      skip: false,
      actionForAll: null,
    });
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it('uses the existing action-for-all without prompting when local data is newer', async () => {
    const sourcePath = path.join(tempDir, 'backup.dat');
    const destinationPath = path.join(tempDir, 'local.dat');
    fs.writeFileSync(sourcePath, 'backup');
    fs.writeFileSync(destinationPath, 'local');
    fs.utimesSync(sourcePath, new Date('2024-02-01T00:00:00Z'), new Date('2024-02-01T00:00:00Z'));
    fs.utimesSync(destinationPath, new Date('2024-03-01T00:00:00Z'), new Date('2024-03-01T00:00:00Z'));

    await expect(shouldSkip([{ sourcePath, destinationPath }], 'Example Game', 'skip')).resolves.toEqual({
      skip: true,
      actionForAll: 'skip',
    });
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it('prompts and returns replace-for-all when the user confirms with the checkbox', async () => {
    const sourcePath = path.join(tempDir, 'backup.dat');
    const destinationPath = path.join(tempDir, 'local.dat');
    fs.writeFileSync(sourcePath, 'backup');
    fs.writeFileSync(destinationPath, 'local');
    fs.utimesSync(sourcePath, new Date('2024-02-01T00:00:00Z'), new Date('2024-02-01T00:00:00Z'));
    fs.utimesSync(destinationPath, new Date('2024-03-01T00:00:00Z'), new Date('2024-03-01T00:00:00Z'));
    mocks.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: true });

    await expect(shouldSkip([{ sourcePath, destinationPath }], 'Example Game', null)).resolves.toEqual({
      skip: false,
      actionForAll: 'replace',
    });
    expect(mocks.showMessageBox).toHaveBeenCalledOnce();
  });
});
