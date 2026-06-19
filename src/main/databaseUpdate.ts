import { app } from 'electron';
import { Database } from 'sqlite3';
import fs from 'fs';
import fse from 'fs-extra';
import https from 'https';
import i18next from 'i18next';
import path from 'path';
import sqlite3 from 'sqlite3';

import { getMainWindow } from './windowManager';

async function updateDatabase(): Promise<void> {
  const progressId = 'update-db';
  const progressTitle = i18next.t('alert.updating_database');
  const databaseLink = 'https://raw.githubusercontent.com/dyang886/Game-Save-Manager/main/database/database.db';
  const dbPath = path.join(app.getPath('userData'), 'GSM Database', 'database.db');
  const backupPath = `${dbPath}.backup`;
  const downloadPath = `${dbPath}.download`;

  getMainWindow()!.webContents.send('update-progress', progressId, progressTitle, 'start');

  try {
    await ensureDirectoryExists(path.dirname(dbPath));
    await backupExistingDatabase(dbPath, backupPath);
    await removeBackup(downloadPath);
    await downloadDatabase(databaseLink, downloadPath, progressId, progressTitle);
    await validateDatabaseFile(downloadPath);
    await fse.move(downloadPath, dbPath, { overwrite: true });
    await removeBackup(backupPath);

    getMainWindow()!.webContents.send('update-progress', progressId, progressTitle, 'end');
    getMainWindow()!.webContents.send('show-alert', 'success', i18next.t('alert.update_db_success'));
  } catch (error) {
    handleUpdateError(error, backupPath, downloadPath, dbPath, progressId, progressTitle);
  }
}

async function ensureDirectoryExists(directoryPath: string): Promise<void> {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }
}

async function backupExistingDatabase(dbPath: string, backupPath: string): Promise<void> {
  if (fs.existsSync(dbPath)) {
    fs.copyFileSync(dbPath, backupPath);
  }
}

async function downloadDatabase(databaseLink: string, dbPath: string, progressId: string, progressTitle: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = https.get(databaseLink, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Database download failed with status ${response.statusCode}`));
        return;
      }

      const totalSize = Number.parseInt(response.headers['content-length'] || '', 10);
      let downloadedSize = 0;

      const fileStream = fs.createWriteStream(dbPath);

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (Number.isFinite(totalSize) && totalSize > 0) {
          const progressPercentage = Math.round((downloadedSize / totalSize) * 100);
          getMainWindow()!.webContents.send('update-progress', progressId, progressTitle, progressPercentage);
        }
      });

      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(() => {
          resolve();
        });
      });

      response.on('error', (error) => {
        reject(error);
      });

      fileStream.on('error', (error) => {
        reject(error);
      });
    });

    request.on('error', (error) => {
      reject(error);
    });
  });
}

async function validateDatabaseFile(dbPath: string): Promise<void> {
  const db = new Database(dbPath, sqlite3.OPEN_READONLY);

  try {
    await new Promise<void>((resolve, reject) => {
      db.get(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'games'",
        (err, row) => {
          if (err) {
            reject(err);
            return;
          }
          if (!row) {
            reject(new Error('Downloaded database does not contain the games table'));
            return;
          }
          resolve();
        }
      );
    });
  } finally {
    await new Promise<void>((resolve) => {
      db.close((err) => {
        if (err) {
          console.error('[validateDatabaseFile] Error closing database:', err);
        }
        resolve();
      });
    });
  }
}

async function removeBackup(backupPath: string): Promise<void> {
  if (fs.existsSync(backupPath)) {
    fs.unlinkSync(backupPath);
  }
}

function handleUpdateError(error: unknown, backupPath: string, downloadPath: string, dbPath: string, progressId: string, progressTitle: string): void {
  if (error instanceof Error) {
    console.error(`An error occurred while updating the database: ${error.message}`);
    getMainWindow()!.webContents.send('show-alert', 'modal', i18next.t('alert.error_during_db_update'), error.message);
  }
  getMainWindow()!.webContents.send('update-progress', progressId, progressTitle, 'end');

  if (fs.existsSync(downloadPath)) {
    fs.unlinkSync(downloadPath);
  }

  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, dbPath);
    fs.unlinkSync(backupPath);
  }
}

export {
  updateDatabase,
};
