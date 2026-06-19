import { app, dialog } from 'electron';
import { globSync } from 'glob';
import { Database } from 'sqlite3';
import fs from 'fs';
import fsOriginal from 'original-fs';
import fse from 'fs-extra';
import i18next from 'i18next';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';
import WinReg from 'winreg';

import {
  applyBackupAnalysis,
  calculateBackupSourceSize,
  getBackupExclusionPatterns,
  shouldExcludePath,
} from './backupMetadata';
import { getNewestBackup } from './backupMigration';
import { handleBackupError } from './backupErrors';
import { getBundledDatabasePath } from './paths';
import { osKeyMap } from './platformPlaceholders';
import { getGameDisplayName, getSettings } from './settingsService';
import { getMainWindow } from './windowManager';
import {
  getWinRegHive,
  parseRegistryPath,
  resolveTemplatedBackupPath,
} from './utils';
import type { Game, ResolvedPath } from '../types/game';

async function getGameDataFromDB(): Promise<{ games: Game[]; errors: string[] }> {
  const games: Game[] = [];
  const errors: string[] = [];
  const dbPath = path.join(app.getPath('userData'), 'GSM Database', 'database.db');

  let db: Database | null = null;
  let stmtInstallFolder: sqlite3.Statement | null = null;

  try {
    await ensureDatabaseExists(dbPath);
    db = new Database(dbPath, sqlite3.OPEN_READONLY);
    stmtInstallFolder = db.prepare('SELECT * FROM games WHERE install_folder = ?');

    const gameInstallPaths = getSettings().gameInstalls;
    const customDBs = await loadCustomDatabases();

    await processGameInstallPaths(gameInstallPaths, stmtInstallFolder, customDBs, games, errors);

    await processCustomEntriesAfterDatabaseGames(games, errors);
  } catch (error) {
    handleBackupError(error, 'Error updating database', errors);
  } finally {
    if (stmtInstallFolder) {
      await new Promise<void>((resolve) => {
        try {
          stmtInstallFolder!.finalize((err) => {
            if (err) {
              console.error('[getGameDataFromDB] Error finalizing statement:', err);
            }
            resolve();
          });
        } catch (e) {
          console.error('[getGameDataFromDB] Exception during statement finalize:', e);
          resolve();
        }
      });
    }

    if (db) {
      await new Promise<void>((resolve) => {
        try {
          db!.close((err) => {
            if (err) {
              console.error('[getGameDataFromDB] Error closing database:', err);
            }
            resolve();
          });
        } catch (e) {
          console.error('[getGameDataFromDB] Exception during db.close():', e);
          resolve();
        }
      });
    }
  }

  return { games, errors };
}

async function ensureDatabaseExists(dbPath: string): Promise<void> {
  if (!fs.existsSync(dbPath)) {
    const installedDbPath = getBundledDatabasePath();
    if (!fs.existsSync(installedDbPath)) {
      dialog.showErrorBox(
        i18next.t('alert.missing_database_file'),
        i18next.t('alert.missing_database_file_message')
      );
      throw Error('Database file is missing');
    } else {
      await fse.copy(installedDbPath, dbPath);
    }
  }
}

async function loadCustomDatabases(): Promise<Game[]> {
  const customDBPath = path.join(getSettings().backupPath, 'custom_database.json');
  const customDBs: Game[] = [];
  if (fs.existsSync(customDBPath)) {
    const customs = JSON.parse(fs.readFileSync(customDBPath, 'utf-8'));
    for (const game of customs) {
      customDBs.push(game);
    }
  }
  return customDBs;
}

async function processGameInstallPaths(
  gameInstallPaths: string[],
  stmtInstallFolder: sqlite3.Statement,
  customDBs: Game[],
  games: Game[],
  errors: string[]
): Promise<void> {
  if (Array.isArray(gameInstallPaths) && gameInstallPaths.length > 0) {
    for (const installPath of gameInstallPaths) {
      const directories = fsOriginal
        .readdirSync(installPath, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name);

      for (const dir of directories) {
        await processDirectory(dir, installPath, stmtInstallFolder, customDBs, games, errors);
      }
    }
  }
}

async function processDirectory(
  dir: string,
  installPath: string,
  stmtInstallFolder: sqlite3.Statement,
  customDBs: Game[],
  games: Game[],
  errors: string[]
): Promise<void> {
  const rows = await queryDatabase(stmtInstallFolder, dir);
  if (rows && rows.length > 0) {
    await processDatabaseRows(rows, dir, installPath, games, errors);
  }

  const customs = customDBs.filter((game) => game.install_folder === dir);
  await processCustomGames(customs, dir, installPath, games, errors);
}

async function queryDatabase(stmtInstallFolder: sqlite3.Statement, dir: string): Promise<any[]> {
  return new Promise<any[]>((resolve, reject) => {
    stmtInstallFolder.all(dir, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

async function processDatabaseRows(rows: any[], dir: string, installPath: string, games: Game[], errors: string[]): Promise<void> {
  for (const row of rows) {
    try {
      row.wiki_page_id = row.wiki_page_id.toString();
      row.platform = JSON.parse(row.platform);
      row.save_location = JSON.parse(row.save_location);
      row.install_path = path.join(installPath, dir);
      row.latest_backup = getNewestBackup(row.wiki_page_id);

      const processed_game = await processGame(row);
      if (processed_game.resolved_paths.length !== 0) {
        games.push(processed_game);
      }
    } catch (err) {
      handleBackupError(err, `Error processing database game ${getGameDisplayName(row)}`, errors);
    }
  }
}

async function processCustomGames(customs: Game[], dir: string, installPath: string, games: Game[], errors: string[]): Promise<void> {
  for (const custom of customs) {
    try {
      custom.wiki_page_id = custom.wiki_page_id.toString();
      custom.platform = ['Custom'];
      custom.install_path = path.join(installPath, dir);
      custom.latest_backup = getNewestBackup(custom.wiki_page_id);

      const processed_game = await processGame(custom);
      if (processed_game.resolved_paths.length !== 0) {
        games.push(processed_game);
      }
    } catch (err) {
      handleBackupError(err, `Error processing custom game ${custom.title}`, errors);
    }
  }
}

async function processCustomEntriesAfterDatabaseGames(games: Game[], errors: string[]): Promise<void> {
  const customJsonPath = path.join(getSettings().backupPath, 'custom_entries.json');
  if (fs.existsSync(customJsonPath)) {
    const { customGames, customGameErrors } = await processCustomEntries(customJsonPath);
    games.push(...customGames);
    errors.push(...customGameErrors);
  }
}

async function processCustomEntries(customJsonPath: string): Promise<{ customGames: Game[]; customGameErrors: string[] }> {
  const customGames: Game[] = [];
  const customGameErrors: string[] = [];

  const customEntries: Game[] = JSON.parse(fs.readFileSync(customJsonPath, 'utf-8'));
  for (let customEntry of customEntries) {
    try {
      customEntry.platform = ['Custom'];
      customEntry.latest_backup = getNewestBackup(customEntry.wiki_page_id);
      for (const plat in customEntry.save_location) {
        const entries = customEntry.save_location[plat] as unknown[];
        customEntry.save_location[plat] = entries.map((entry) => {
          if (typeof entry === 'string') {
            return entry;
          }
          return (entry as { template: string }).template;
        });
      }

      const processed_game = await processGame(customEntry);
      if (processed_game.resolved_paths.length !== 0) {
        customGames.push(processed_game);
      }
    } catch (err) {
      handleBackupError(err, `Error processing custom game ${customEntry.title}`, customGameErrors);
    }
  }

  return { customGames, customGameErrors };
}

async function getAllGameDataFromDB(): Promise<Game[]> {
  return new Promise((resolve, reject) => {
    const dbPath = path.join(app.getPath('userData'), 'GSM Database', 'database.db');
    const db = new Database(dbPath, sqlite3.OPEN_READONLY);

    const games: Game[] = [];

    db.serialize(async () => {
      const stmtGetAllGames = db.prepare('SELECT * FROM games');

      try {
        const rows = await new Promise<any[]>((resolve, reject) => {
          stmtGetAllGames.all((err, rows) => {
            if (err) {
              console.error('Error querying all games:', err);
              reject(err);
            } else {
              resolve(rows);
            }
          });
        });

        if (rows && rows.length > 0) {
          for (const row of rows) {
            row.platform = JSON.parse(row.platform);
            row.save_location = JSON.parse(row.save_location);
            row.latest_backup = getNewestBackup(row.wiki_page_id);

            const processed_game = await processGame(row);
            if (processed_game.resolved_paths.length !== 0) {
              games.push(processed_game);
            }
          }
        }

        stmtGetAllGames.finalize(() => {
          db.close();
          resolve(games);
        });
      } catch (error) {
        console.error('Error during processing:', error);
        db.close();
        reject(error);
      }
    });
  });
}

async function processGame(db_game_row: Game): Promise<Game> {
  const resolved_paths: ResolvedPath[] = [];
  let totalBackupSize = 0;

  const currentOS = os.platform();
  const osKey = osKeyMap[currentOS];

  if (osKey && db_game_row.save_location[osKey]) {
    totalBackupSize += await processFilePaths(db_game_row, osKey, resolved_paths);
  }

  if (osKey === 'win' && db_game_row.save_location['reg'] && db_game_row.save_location['reg'].length > 0) {
    await processRegistryPaths(db_game_row, resolved_paths);
  }

  db_game_row.resolved_paths = resolved_paths;
  db_game_row.backup_size = totalBackupSize;

  return applyBackupAnalysis(db_game_row);
}

async function processFilePaths(db_game_row: Game, osKey: string, resolved_paths: ResolvedPath[]): Promise<number> {
  let totalBackupSize = 0;

  for (const templatedPath of db_game_row.save_location[osKey]) {
    const resolvedPath = await resolveTemplatedBackupPath(templatedPath, db_game_row.install_path);

    if (resolvedPath.path.includes('*')) {
      totalBackupSize += await processWildcardPaths(resolvedPath, templatedPath, resolved_paths);
    } else {
      totalBackupSize += await processSinglePath(resolvedPath, templatedPath, resolved_paths);
    }
  }

  return totalBackupSize;
}

async function processWildcardPaths(resolvedPath: { path: string; uid?: string }, templatedPath: string, resolved_paths: ResolvedPath[]): Promise<number> {
  let totalBackupSize = 0;
  const exclusionPatterns = getBackupExclusionPatterns();
  const files = globSync(resolvedPath.path.replace(/\\/g, '/'));

  for (const filePath of files) {
    if (fsOriginal.existsSync(filePath) && !shouldExcludePath(filePath, exclusionPatterns)) {
      totalBackupSize += calculateBackupSourceSize(filePath, exclusionPatterns);
      resolved_paths.push({
        template: templatedPath,
        resolved: path.normalize(filePath),
        uid: resolvedPath.uid,
      });
    }
  }

  return totalBackupSize;
}

async function processSinglePath(resolvedPath: { path: string; uid?: string }, templatedPath: string, resolved_paths: ResolvedPath[]): Promise<number> {
  let totalBackupSize = 0;
  const exclusionPatterns = getBackupExclusionPatterns();

  if (fsOriginal.existsSync(resolvedPath.path) && !shouldExcludePath(resolvedPath.path, exclusionPatterns)) {
    totalBackupSize += calculateBackupSourceSize(resolvedPath.path, exclusionPatterns);
    resolved_paths.push({
      template: templatedPath,
      resolved: path.normalize(resolvedPath.path),
      uid: resolvedPath.uid,
    });
  }

  return totalBackupSize;
}

async function processRegistryPaths(db_game_row: Game, resolved_paths: ResolvedPath[]): Promise<void> {
  for (const templatedPath of db_game_row.save_location['reg']) {
    const resolvedPath = await resolveTemplatedBackupPath(templatedPath, null);
    const normalizedRegPath = path.normalize(resolvedPath.path);
    const { hive, key } = parseRegistryPath(normalizedRegPath);
    const winRegHive = getWinRegHive(hive);

    if (!winRegHive) {
      continue;
    }

    const registryKey = new WinReg({
      hive: winRegHive,
      key: key,
    });

    await new Promise<void>((resolve, reject) => {
      registryKey.keyExists((err, exists) => {
        if (err) {
          getMainWindow()!.webContents.send(
            'show-alert',
            'error',
            `${i18next.t('alert.registry_existence_check_failed')}: ${db_game_row.title}`
          );
          console.error(`Error checking registry existence for ${db_game_row.title}: ${err}`);
          return reject(err);
        }
        if (exists) {
          resolved_paths.push({
            template: templatedPath,
            resolved: normalizedRegPath,
            uid: resolvedPath.uid,
            type: 'reg',
          });
        }
        resolve();
      });
    });
  }
}

export {
  getAllGameDataFromDB,
  getGameDataFromDB,
};
