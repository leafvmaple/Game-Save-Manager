import i18next from 'i18next';

import { backupGame, getGameDataFromDB } from './backup';
import {
  getLatestBackupDate,
  getLatestResolvedPathMTime,
  shouldAutoBackupGame,
} from './backupMetadata';
import {
  getAppStatus,
  getMainWindow,
  getSettings,
  updateAppStatus,
} from './global';

const DEFAULT_AUTO_BACKUP_INTERVAL_MINUTES = 30;
const MIN_AUTO_BACKUP_INTERVAL_MINUTES = 5;
const MAX_AUTO_BACKUP_INTERVAL_MINUTES = 1440;

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
