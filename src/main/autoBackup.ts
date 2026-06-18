import fsOriginal from 'original-fs';
import i18next from 'i18next';
import moment from 'moment';
import path from 'path';
import type { Dirent } from 'fs';

import { backupGame, getGameDataFromDB } from './backup';
import {
  getAppStatus,
  getMainWindow,
  getSettings,
  updateAppStatus,
} from './global';
import type { Game, ResolvedPath } from '../types/game';

const DEFAULT_AUTO_BACKUP_INTERVAL_MINUTES = 30;
const MIN_AUTO_BACKUP_INTERVAL_MINUTES = 5;
const MAX_AUTO_BACKUP_INTERVAL_MINUTES = 1440;
const BACKUP_FOLDER_FORMAT = 'YYYY-MM-DD_HH-mm';

let autoBackupIntervalTimer: ReturnType<typeof setInterval> | null = null;
let autoBackupStartupTimer: ReturnType<typeof setTimeout> | null = null;
let autoBackupRunning = false;

interface AutoBackupResult {
  backedUp: number;
  failed: number;
  skipped: number;
  errors: string[];
}

function sanitizeAutoBackupInterval(value: unknown): number {
  const interval = Number.parseInt(String(value), 10);
  if (!Number.isFinite(interval)) {
    return DEFAULT_AUTO_BACKUP_INTERVAL_MINUTES;
  }
  return Math.min(
    Math.max(interval, MIN_AUTO_BACKUP_INTERVAL_MINUTES),
    MAX_AUTO_BACKUP_INTERVAL_MINUTES
  );
}

function getLatestBackupDate(wikiPageId: string, backupRoot = getSettings().backupPath): Date | null {
  const gameBackupPath = path.join(backupRoot, wikiPageId.toString());
  if (!fsOriginal.existsSync(gameBackupPath)) {
    return null;
  }

  let latestBackupDate: Date | null = null;
  let backupEntries: Dirent[];
  try {
    backupEntries = fsOriginal.readdirSync(gameBackupPath, { withFileTypes: true });
  } catch (error) {
    console.warn(`Failed to inspect backup directory: ${gameBackupPath}`, error);
    return null;
  }

  for (const entry of backupEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const parsedDate = moment(entry.name, BACKUP_FOLDER_FORMAT, true);
      if (!parsedDate.isValid()) {
        continue;
      }

      const backupConfigPath = path.join(gameBackupPath, entry.name, 'backup_info.json');
      const backupDate = fsOriginal.existsSync(backupConfigPath)
        ? new Date(Math.max(parsedDate.toDate().getTime(), fsOriginal.statSync(backupConfigPath).mtime.getTime()))
        : parsedDate.toDate();

      if (!latestBackupDate || backupDate.getTime() > latestBackupDate.getTime()) {
        latestBackupDate = backupDate;
      }
    } catch (error) {
      console.warn(`Failed to inspect backup entry: ${path.join(gameBackupPath, entry.name)}`, error);
    }
  }

  return latestBackupDate;
}

function getLatestResolvedPathMTime(resolvedPaths: ResolvedPath[]): Date | null {
  let latestMTime: Date | null = null;

  for (const resolvedPath of resolvedPaths) {
    if (resolvedPath.type === 'reg') {
      continue;
    }

    const pathMTime = getLatestPathMTime(resolvedPath.resolved);
    if (pathMTime && (!latestMTime || pathMTime.getTime() > latestMTime.getTime())) {
      latestMTime = pathMTime;
    }
  }

  return latestMTime;
}

function shouldAutoBackupGame(game: Game, backupRoot = getSettings().backupPath): boolean {
  if (!game.resolved_paths || game.resolved_paths.length === 0) {
    return false;
  }

  const latestBackupDate = getLatestBackupDate(game.wiki_page_id, backupRoot);
  if (!latestBackupDate) {
    return true;
  }

  const latestSaveMTime = getLatestResolvedPathMTime(game.resolved_paths);
  if (!latestSaveMTime) {
    return false;
  }

  return latestSaveMTime.getTime() > latestBackupDate.getTime();
}

async function runAutoBackup(): Promise<AutoBackupResult> {
  const result: AutoBackupResult = {
    backedUp: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  const settings = getSettings();
  if (settings?.autoBackupEnabled !== true) {
    return result;
  }

  if (autoBackupRunning || Object.values(getAppStatus()).some(Boolean)) {
    result.skipped += 1;
    return result;
  }

  autoBackupRunning = true;
  updateAppStatus('auto_backuping', true);

  try {
    const { games, errors } = await getGameDataFromDB();
    if (errors.length > 0) {
      console.warn('Auto backup scan completed with errors:', errors);
      result.errors.push(...errors);
    }

    for (const game of games) {
      if (!shouldAutoBackupGame(game)) {
        result.skipped += 1;
        continue;
      }

      const backupError = await backupGame(game);
      if (backupError) {
        result.failed += 1;
        result.errors.push(backupError);
      } else {
        result.backedUp += 1;
      }
    }

    notifyAutoBackupResult(result);
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Auto backup failed:', error);
    result.failed += 1;
    result.errors.push(errorMessage);
    notifyAutoBackupResult(result);
    return result;
  } finally {
    updateAppStatus('auto_backuping', false);
    autoBackupRunning = false;
  }
}

function startAutoBackupScheduler(): void {
  refreshAutoBackupScheduler(false);
}

function refreshAutoBackupScheduler(runSoon = false): void {
  stopAutoBackupScheduler();

  const settings = getSettings();
  if (settings?.autoBackupEnabled !== true) {
    return;
  }

  const intervalMs = sanitizeAutoBackupInterval(settings.autoBackupInterval) * 60 * 1000;
  const startupDelayMs = runSoon ? 1000 : Math.min(intervalMs, 60 * 1000);

  autoBackupStartupTimer = setTimeout(() => {
    void runAutoBackup();
  }, startupDelayMs);

  autoBackupIntervalTimer = setInterval(() => {
    void runAutoBackup();
  }, intervalMs);
}

function stopAutoBackupScheduler(): void {
  if (autoBackupStartupTimer) {
    clearTimeout(autoBackupStartupTimer);
    autoBackupStartupTimer = null;
  }
  if (autoBackupIntervalTimer) {
    clearInterval(autoBackupIntervalTimer);
    autoBackupIntervalTimer = null;
  }
}

function getLatestPathMTime(targetPath: string): Date | null {
  try {
    if (!targetPath || !fsOriginal.existsSync(targetPath)) {
      return null;
    }

    const stats = fsOriginal.lstatSync(targetPath);
    let latestMTime = stats.mtime;

    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return latestMTime;
    }

    for (const child of fsOriginal.readdirSync(targetPath)) {
      const childMTime = getLatestPathMTime(path.join(targetPath, child));
      if (childMTime && childMTime.getTime() > latestMTime.getTime()) {
        latestMTime = childMTime;
      }
    }

    return latestMTime;
  } catch (error) {
    console.warn(`Failed to inspect auto backup path: ${targetPath}`, error);
    return null;
  }
}

function notifyAutoBackupResult(result: AutoBackupResult): void {
  const mainWindow = getMainWindow();
  if (!mainWindow) {
    return;
  }

  if (result.backedUp > 0) {
    mainWindow.webContents.send('update-backup-table');
    mainWindow.webContents.send('update-restore-table');
    mainWindow.webContents.send(
      'show-alert',
      'success',
      i18next.t('alert.auto_backup_complete', { count: result.backedUp })
    );
  }

  if (result.failed > 0) {
    mainWindow.webContents.send(
      'show-alert',
      'modal',
      i18next.t('alert.auto_backup_failed', { count: result.failed }),
      result.errors
    );
  }
}

export {
  DEFAULT_AUTO_BACKUP_INTERVAL_MINUTES,
  MIN_AUTO_BACKUP_INTERVAL_MINUTES,
  MAX_AUTO_BACKUP_INTERVAL_MINUTES,
  getLatestBackupDate,
  getLatestResolvedPathMTime,
  refreshAutoBackupScheduler,
  runAutoBackup,
  sanitizeAutoBackupInterval,
  shouldAutoBackupGame,
  startAutoBackupScheduler,
  stopAutoBackupScheduler,
};
