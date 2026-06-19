import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  gameData: {
    steamPath: '',
    ubisoftPath: '',
    currentSteamUserId64: '76561198000000000',
    currentSteamUserId3: '123456',
    currentUbisoftUserId: 'ubisoft-user',
  },
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => `mock-${name}`),
  },
}));

vi.mock('original-fs', async () => {
  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actualFs, default: actualFs };
});

vi.mock('winreg', () => ({
  default: {
    HKCU: 'HKCU',
    HKLM: 'HKLM',
    HKCR: 'HKCR',
  },
}));

vi.mock('../../src/main/gameData', () => ({
  getGameData: () => mocks.gameData,
}));

vi.mock('../../src/main/platformPlaceholders', () => ({
  osKeyMap: {
    win32: 'win',
    darwin: 'mac',
    linux: 'linux',
  },
  placeholderMapping: {
    '{{p|username}}': 'Player',
    '{{p|userprofile}}': 'C:\\Users\\Player',
    '{{p|appdata}}': 'C:\\Users\\Player\\AppData\\Roaming',
    '{{p|localappdata}}': 'C:\\Users\\Player\\AppData\\Local',
  },
  placeholderIdentifier: {
    '{{p|username}}': '{{p1}}',
    '{{p|userprofile}}': '{{p2}}',
    '{{p|appdata}}': '{{p5}}',
    '{{p|localappdata}}': '{{p6}}',
    '{{p|game}}': '{{p11}}',
    '{{p|uid}}': '{{p12}}',
    '{{p|steam}}': '{{p13}}',
    '{{p|uplay}}': '{{p14}}',
    '{{p|ubisoftconnect}}': '{{p14}}',
  },
}));

import {
  extractUidFromPath,
  fillPathUid,
  finalizeTemplate,
  findLatestModifiedPath,
  getWinRegHive,
  parseRegistryPath,
  resolveTemplatedBackupPath,
} from '../../src/main/utils';

describe('main utils', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-utils-'));
    mocks.gameData.steamPath = path.join(tempDir, 'Steam');
    mocks.gameData.ubisoftPath = path.join(tempDir, 'Ubisoft Connect');
    mocks.gameData.currentSteamUserId64 = '76561198000000000';
    mocks.gameData.currentSteamUserId3 = '123456';
    mocks.gameData.currentUbisoftUserId = 'ubisoft-user';
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('maps supported registry hives to winreg constants', () => {
    expect(getWinRegHive('HKEY_CURRENT_USER')).toBe('HKCU');
    expect(getWinRegHive('HKEY_LOCAL_MACHINE')).toBe('HKLM');
    expect(getWinRegHive('HKEY_CLASSES_ROOT')).toBe('HKCR');
    expect(getWinRegHive('HKEY_UNKNOWN')).toBeNull();
  });

  it('splits a registry path into hive and key', () => {
    expect(parseRegistryPath('HKEY_CURRENT_USER\\Software\\Game')).toEqual({
      hive: 'HKEY_CURRENT_USER',
      key: '\\Software\\Game',
    });
  });

  it('resolves game and launcher placeholders for backup paths', async () => {
    const gameInstallPath = path.join(tempDir, 'Library', 'Example Game');

    await expect(resolveTemplatedBackupPath('{{p|game}}\\Saves', gameInstallPath)).resolves.toEqual({
      path: `${gameInstallPath}\\Saves`,
    });

    await expect(resolveTemplatedBackupPath('{{p|steam}}\\userdata', gameInstallPath)).resolves.toEqual({
      path: `${mocks.gameData.steamPath}\\userdata`,
    });
  });

  it('rejects unresolved placeholders instead of returning a partial path', async () => {
    await expect(resolveTemplatedBackupPath('{{p|unknown}}\\Saves', null)).resolves.toEqual({
      path: '',
    });
  });

  it('fills uid placeholders with a known user id when the path exists', async () => {
    const savePath = path.join(mocks.gameData.steamPath, 'userdata', mocks.gameData.currentSteamUserId64, 'remote');
    fs.mkdirSync(savePath, { recursive: true });

    const result = await fillPathUid(path.join(mocks.gameData.steamPath, 'userdata', '{{p|uid}}', 'remote'));

    expect(result.uid).toBe(mocks.gameData.currentSteamUserId64);
    expect(path.normalize(result.path)).toBe(savePath);
  });

  it('falls back to the most recently modified wildcard uid path', async () => {
    const olderPath = path.join(mocks.gameData.steamPath, 'userdata', 'older-user', 'remote');
    const newerPath = path.join(mocks.gameData.steamPath, 'userdata', 'newer-user', 'remote');
    fs.mkdirSync(olderPath, { recursive: true });
    fs.mkdirSync(newerPath, { recursive: true });
    fs.writeFileSync(path.join(olderPath, 'save.dat'), 'older');
    fs.writeFileSync(path.join(newerPath, 'save.dat'), 'newer');
    fs.utimesSync(olderPath, new Date('2024-01-01T00:00:00Z'), new Date('2024-01-01T00:00:00Z'));
    fs.utimesSync(newerPath, new Date('2024-02-01T00:00:00Z'), new Date('2024-02-01T00:00:00Z'));
    mocks.gameData.currentSteamUserId64 = 'missing-64';
    mocks.gameData.currentSteamUserId3 = 'missing-3';
    mocks.gameData.currentUbisoftUserId = 'missing-ubisoft';

    const result = await fillPathUid(path.join(mocks.gameData.steamPath, 'userdata', '{{p|uid}}', 'remote'));

    expect(result.uid).toBe('newer-user');
    expect(path.normalize(result.path)).toBe(newerPath);
  });

  it('extracts uid values from templated path segments', () => {
    const template = path.join('profiles', 'user_{{p|uid}}', 'save');
    const resolved = path.join('profiles', 'user_abc123', 'save');

    expect(extractUidFromPath(template, resolved)).toBe('abc123');
  });

  it('finds the latest modified path', async () => {
    const olderPath = path.join(tempDir, 'older');
    const newerPath = path.join(tempDir, 'newer');
    fs.mkdirSync(olderPath);
    fs.mkdirSync(newerPath);
    fs.utimesSync(olderPath, new Date('2024-01-01T00:00:00Z'), new Date('2024-01-01T00:00:00Z'));
    fs.utimesSync(newerPath, new Date('2024-03-01T00:00:00Z'), new Date('2024-03-01T00:00:00Z'));

    await expect(findLatestModifiedPath([olderPath, newerPath])).resolves.toBe(newerPath);
  });

  it('finalizes templates by preserving wildcard path segments', () => {
    const gameInstallPath = path.join(tempDir, 'Library', 'Example Game');
    const resolvedPath = path.join(gameInstallPath, 'Saves', 'SlotA', 'profile.dat');

    expect(finalizeTemplate('{{p|game}}\\Saves\\*\\profile.dat', resolvedPath, undefined, gameInstallPath))
      .toBe(path.join('{{p|game}}', 'Saves', 'SlotA', 'profile.dat'));
  });

  it('finalizes uid placeholders using the resolved uid', () => {
    const resolvedPath = path.join(mocks.gameData.steamPath, 'userdata', '123456', 'remote');

    expect(finalizeTemplate('{{p|steam}}\\userdata\\{{p|uid}}\\remote', resolvedPath, '123456', ''))
      .toBe(path.join('{{p|steam}}', 'userdata', '123456', 'remote'));
  });
});
