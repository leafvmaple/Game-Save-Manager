import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: {
    backupPath: '',
    autoBackupEnabled: true,
    autoBackupInterval: 30,
  },
  status: {
    backuping: false,
    auto_backuping: false,
    restoring: false,
    migrating: false,
    updating_db: false,
  } as Record<string, boolean>,
  sent: [] as unknown[][],
  getGameDataFromDB: vi.fn(),
  backupGame: vi.fn(),
  updateAppStatus: vi.fn(),
}));

vi.mock('original-fs', async () => {
  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actualFs, default: actualFs };
});

vi.mock('i18next', () => ({
  default: {
    t: vi.fn((key: string, options?: Record<string, unknown>) => {
      if (options?.count) return `${key}:${options.count}`;
      return key;
    }),
  },
}));

vi.mock('../../src/main/global', () => ({
  getSettings: () => mocks.settings,
  getAppStatus: () => mocks.status,
  updateAppStatus: mocks.updateAppStatus,
  getMainWindow: () => ({
    webContents: {
      send: (...args: unknown[]) => mocks.sent.push(args),
    },
  }),
}));

vi.mock('../../src/main/backup', () => ({
  getGameDataFromDB: mocks.getGameDataFromDB,
  backupGame: mocks.backupGame,
}));

import {
  getLatestBackupDate,
  runAutoBackup,
  sanitizeAutoBackupInterval,
  shouldAutoBackupGame,
} from '../../src/main/autoBackup';

describe('auto backup', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-auto-backup-'));
    mocks.settings.backupPath = path.join(tempDir, 'Backups');
    mocks.settings.autoBackupEnabled = true;
    mocks.settings.autoBackupInterval = 30;
    mocks.status.backuping = false;
    mocks.status.auto_backuping = false;
    mocks.status.restoring = false;
    mocks.status.migrating = false;
    mocks.status.updating_db = false;
    mocks.sent.length = 0;
    mocks.getGameDataFromDB.mockReset();
    mocks.backupGame.mockReset();
    mocks.updateAppStatus.mockReset();
    mocks.updateAppStatus.mockImplementation((key: string, value: boolean) => {
      mocks.status[key] = value;
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('sanitizes auto backup intervals', () => {
    expect(sanitizeAutoBackupInterval(undefined)).toBe(30);
    expect(sanitizeAutoBackupInterval('1')).toBe(5);
    expect(sanitizeAutoBackupInterval('45')).toBe(45);
    expect(sanitizeAutoBackupInterval('9999')).toBe(1440);
  });

  it('finds the newest valid backup folder and prefers backup metadata mtime', () => {
    const gameBackupRoot = path.join(mocks.settings.backupPath, '123');
    fs.mkdirSync(path.join(gameBackupRoot, '2024-01-01_10-00'), { recursive: true });
    fs.mkdirSync(path.join(gameBackupRoot, 'not-a-backup'), { recursive: true });

    const newestBackup = path.join(gameBackupRoot, '2024-02-03_04-05');
    const backupInfo = path.join(newestBackup, 'backup_info.json');
    fs.mkdirSync(newestBackup, { recursive: true });
    fs.writeFileSync(backupInfo, '{}');
    const backupInfoMTime = new Date(2024, 1, 3, 4, 5, 30);
    fs.utimesSync(backupInfo, backupInfoMTime, backupInfoMTime);

    expect(getLatestBackupDate('123')?.getTime()).toBe(backupInfoMTime.getTime());
  });

  it('backs up file saves only when local data is newer than the latest backup', () => {
    const saveFile = path.join(tempDir, 'save.dat');
    fs.writeFileSync(saveFile, 'save');
    fs.utimesSync(saveFile, new Date(2024, 0, 2), new Date(2024, 0, 2));

    const game = createGame('file-game', saveFile);

    expect(shouldAutoBackupGame(game)).toBe(true);

    const backupInfo = createBackup('file-game', '2024-01-03_00-00');
    const backupMTime = new Date(2024, 0, 3);
    fs.utimesSync(backupInfo, backupMTime, backupMTime);

    expect(shouldAutoBackupGame(game)).toBe(false);
  });

  it('creates one baseline backup for registry-only games and then skips repeats', () => {
    const game = {
      ...createGame('registry-game', 'HKEY_CURRENT_USER\\Software\\Game'),
      resolved_paths: [{
        template: '{{p|hkcu}}\\Software\\Game',
        resolved: 'HKEY_CURRENT_USER\\Software\\Game',
        type: 'reg',
      }],
    };

    expect(shouldAutoBackupGame(game)).toBe(true);

    createBackup('registry-game', '2024-01-03_00-00');

    expect(shouldAutoBackupGame(game)).toBe(false);
  });

  it('runs backups only for changed games and refreshes visible tables', async () => {
    const changedSave = path.join(tempDir, 'changed.dat');
    const unchangedSave = path.join(tempDir, 'unchanged.dat');
    fs.writeFileSync(changedSave, 'changed');
    fs.writeFileSync(unchangedSave, 'unchanged');
    fs.utimesSync(unchangedSave, new Date(2024, 0, 1), new Date(2024, 0, 1));

    const unchangedBackup = createBackup('unchanged-game', '2024-01-03_00-00');
    fs.utimesSync(unchangedBackup, new Date(2024, 0, 3), new Date(2024, 0, 3));

    const changedGame = createGame('changed-game', changedSave);
    const unchangedGame = createGame('unchanged-game', unchangedSave);
    mocks.getGameDataFromDB.mockResolvedValue({ games: [changedGame, unchangedGame], errors: [] });
    mocks.backupGame.mockResolvedValue(null);

    await expect(runAutoBackup()).resolves.toEqual({
      backedUp: 1,
      failed: 0,
      skipped: 1,
      errors: [],
    });

    expect(mocks.backupGame).toHaveBeenCalledWith(changedGame);
    expect(mocks.backupGame).toHaveBeenCalledTimes(1);
    expect(mocks.updateAppStatus).toHaveBeenNthCalledWith(1, 'auto_backuping', true);
    expect(mocks.updateAppStatus).toHaveBeenLastCalledWith('auto_backuping', false);
    expect(mocks.sent).toContainEqual(['update-backup-table']);
    expect(mocks.sent).toContainEqual(['update-restore-table']);
    expect(mocks.sent).toContainEqual(['show-alert', 'success', 'alert.auto_backup_complete:1']);
  });

  it('skips the run when another operation is active', async () => {
    mocks.status.backuping = true;

    await expect(runAutoBackup()).resolves.toEqual({
      backedUp: 0,
      failed: 0,
      skipped: 1,
      errors: [],
    });

    expect(mocks.getGameDataFromDB).not.toHaveBeenCalled();
    expect(mocks.backupGame).not.toHaveBeenCalled();
    expect(mocks.updateAppStatus).not.toHaveBeenCalled();
  });

  function createGame(wikiPageId: string, resolvedPath: string): any {
    return {
      title: wikiPageId,
      wiki_page_id: wikiPageId,
      install_folder: wikiPageId,
      save_location: { win: [], reg: [], mac: [], linux: [] },
      platform: ['Custom'],
      install_path: '',
      latest_backup: '',
      backup_size: 0,
      resolved_paths: [{
        template: '{{p|game}}',
        resolved: resolvedPath,
      }],
    };
  }

  function createBackup(wikiPageId: string, folderName: string): string {
    const backupPath = path.join(mocks.settings.backupPath, wikiPageId, folderName);
    const backupInfo = path.join(backupPath, 'backup_info.json');
    fs.mkdirSync(backupPath, { recursive: true });
    fs.writeFileSync(backupInfo, '{}');
    return backupInfo;
  }
});
