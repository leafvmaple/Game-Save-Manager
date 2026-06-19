import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: {
    backupPath: '',
    excludedBackupPatterns: [] as string[],
    backupSizeWarningEnabled: true,
    backupSizeWarningThresholdMb: 1024,
    backupSizeWarningMultiplier: 3,
  },
}));

vi.mock('original-fs', async () => {
  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actualFs, default: actualFs };
});

vi.mock('../../src/main/settingsService', () => ({
  getSettings: () => mocks.settings,
}));

import {
  calculateBackupSourceSize,
  collectSourceManifest,
  copyDirectoryWithExclusions,
  getBackupChangeStatus,
  getBackupSizeWarning,
  shouldExcludePath,
  validateBackupInstance,
} from '../../src/main/backupMetadata';

describe('backup metadata helpers', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-backup-metadata-'));
    mocks.settings.backupPath = path.join(tempDir, 'Backups');
    mocks.settings.excludedBackupPatterns = [];
    mocks.settings.backupSizeWarningEnabled = true;
    mocks.settings.backupSizeWarningThresholdMb = 1024;
    mocks.settings.backupSizeWarningMultiplier = 3;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('applies exclusion patterns to size, manifest, and copying', () => {
    const saveRoot = path.join(tempDir, 'Save');
    const nestedRoot = path.join(saveRoot, 'remote');
    fs.mkdirSync(nestedRoot, { recursive: true });
    fs.writeFileSync(path.join(saveRoot, 'keep.dat'), 'keep');
    fs.writeFileSync(path.join(nestedRoot, 'remotecache.vdf'), 'ignore me');
    mocks.settings.excludedBackupPatterns = ['**/remotecache.vdf'];

    expect(shouldExcludePath(path.join(nestedRoot, 'remotecache.vdf'))).toBe(true);
    expect(calculateBackupSourceSize(saveRoot)).toBe(4);

    const manifest = collectSourceManifest(saveRoot);
    expect(manifest.files.map(file => file.relative_path)).toContain('keep.dat');
    expect(manifest.files.map(file => file.relative_path)).not.toContain('remote/remotecache.vdf');
    expect(manifest.excluded).toContain('remote/remotecache.vdf');

    const targetRoot = path.join(tempDir, 'Backup');
    copyDirectoryWithExclusions(saveRoot, targetRoot);
    expect(fs.existsSync(path.join(targetRoot, 'keep.dat'))).toBe(true);
    expect(fs.existsSync(path.join(targetRoot, 'remote', 'remotecache.vdf'))).toBe(false);
  });

  it('classifies games as new, unchanged, or updated', () => {
    const saveFile = path.join(tempDir, 'save.dat');
    fs.writeFileSync(saveFile, 'save');
    fs.utimesSync(saveFile, new Date(2024, 0, 2), new Date(2024, 0, 2));

    const game = createGame('status-game', saveFile, 4);

    expect(getBackupChangeStatus(game)).toBe('new');

    const backupInfo = createBackupInfo('status-game', '2024-01-03_00-00', 4);
    fs.utimesSync(backupInfo, new Date(2024, 0, 3), new Date(2024, 0, 3));
    expect(getBackupChangeStatus(game)).toBe('unchanged');

    fs.utimesSync(saveFile, new Date(2024, 0, 4), new Date(2024, 0, 4));
    expect(getBackupChangeStatus(game)).toBe('updated');
  });

  it('warns when the current backup size grows abnormally', () => {
    mocks.settings.backupSizeWarningMultiplier = 2;
    mocks.settings.backupSizeWarningThresholdMb = 102400;
    createBackupInfo('size-game', '2024-01-03_00-00', 10 * 1024 * 1024);
    const game = createGame('size-game', path.join(tempDir, 'save.dat'), 250 * 1024 * 1024);

    expect(getBackupSizeWarning(game)).toEqual({
      type: 'growth',
      current_size: 250 * 1024 * 1024,
      reference_size: 10 * 1024 * 1024,
    });
  });

  it('validates backup file manifests', async () => {
    const backupPath = path.join(mocks.settings.backupPath, 'validate-game', '2024-01-03_00-00');
    const pathFolder = path.join(backupPath, 'path1');
    fs.mkdirSync(pathFolder, { recursive: true });
    fs.writeFileSync(path.join(backupPath, 'backup_info.json'), JSON.stringify({
      schema_version: 2,
      title: 'Validate Game',
      zh_CN: null,
      backup_paths: [{
        folder_name: 'path1',
        template: '{{p|game}}',
        type: 'file',
        install_folder: 'Validate Game',
        files: [{
          relative_path: 'save.dat',
          type: 'file',
          size: 4,
          mtime_ms: Date.now(),
        }],
      }],
    }));

    await expect(validateBackupInstance(backupPath)).resolves.toMatchObject({
      valid: false,
      checked_files: 1,
      missing_files: 1,
    });

    fs.writeFileSync(path.join(pathFolder, 'save.dat'), 'save');
    await expect(validateBackupInstance(backupPath)).resolves.toMatchObject({
      valid: true,
      checked_files: 1,
      missing_files: 0,
    });
  });

  function createGame(wikiPageId: string, resolvedPath: string, backupSize: number): any {
    return {
      title: wikiPageId,
      wiki_page_id: wikiPageId,
      install_folder: wikiPageId,
      save_location: { win: [], reg: [], mac: [], linux: [] },
      platform: ['Custom'],
      install_path: '',
      latest_backup: '',
      backup_size: backupSize,
      resolved_paths: [{
        template: '{{p|game}}',
        resolved: resolvedPath,
      }],
    };
  }

  function createBackupInfo(wikiPageId: string, folderName: string, backupSize: number): string {
    const backupPath = path.join(mocks.settings.backupPath, wikiPageId, folderName);
    const backupInfo = path.join(backupPath, 'backup_info.json');
    fs.mkdirSync(backupPath, { recursive: true });
    fs.writeFileSync(backupInfo, JSON.stringify({
      schema_version: 2,
      title: wikiPageId,
      zh_CN: null,
      backup_total_size: backupSize,
      backup_paths: [],
    }));
    return backupInfo;
  }
});
