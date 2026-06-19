import fsOriginal from 'original-fs';
import moment from 'moment';
import path from 'path';
import type { Dirent } from 'fs';

import { getSettings } from './settingsService';
import type { Game, ResolvedPath } from '../types/game';
import type {
  BackupChangeStatus,
  BackupFileEntry,
  BackupSizeWarning,
  BackupValidationResult,
} from '../types/backup';

const BACKUP_FOLDER_FORMAT = 'YYYY-MM-DD_HH-mm';
const DEFAULT_SIZE_WARNING_THRESHOLD_MB = 1024;
const DEFAULT_SIZE_WARNING_MULTIPLIER = 3;
const MIN_SIZE_WARNING_DELTA_BYTES = 100 * 1024 * 1024;

interface BackupHistoryEntry {
  date: string;
  path: string;
  size: number;
  createdAt: Date;
}

interface SourceManifest {
  files: BackupFileEntry[];
  excluded: string[];
  size: number;
}

function getBackupExclusionPatterns(): string[] {
  const patterns = getSettings()?.excludedBackupPatterns;
  if (!Array.isArray(patterns)) {
    return [];
  }
  return patterns
    .map(pattern => String(pattern).trim())
    .filter(Boolean);
}

function shouldExcludePath(targetPath: string, patterns = getBackupExclusionPatterns(), rootPath?: string): boolean {
  if (!targetPath || patterns.length === 0) {
    return false;
  }

  const normalizedTarget = normalizeForMatch(targetPath);
  const basename = path.basename(targetPath).toLowerCase();
  const relativePath = rootPath ? normalizeForMatch(path.relative(rootPath, targetPath)) : '';

  return patterns.some(pattern => {
    const normalizedPattern = normalizeForMatch(pattern.trim());
    if (!normalizedPattern) {
      return false;
    }

    if (!normalizedPattern.includes('/')) {
      return globMatches(basename, normalizedPattern);
    }

    return globMatches(normalizedTarget, normalizedPattern)
      || Boolean(relativePath && !relativePath.startsWith('..') && globMatches(relativePath, normalizedPattern));
  });
}

function collectSourceManifest(sourcePath: string, patterns = getBackupExclusionPatterns()): SourceManifest {
  const manifest: SourceManifest = {
    files: [],
    excluded: [],
    size: 0,
  };

  collectSourceManifestEntry(sourcePath, sourcePath, patterns, manifest);
  return manifest;
}

function copyDirectoryWithExclusions(sourcePath: string, targetPath: string, patterns = getBackupExclusionPatterns(), rootPath = sourcePath): void {
  fsOriginal.mkdirSync(targetPath, { recursive: true });

  for (const item of fsOriginal.readdirSync(sourcePath, { withFileTypes: true })) {
    const sourceItemPath = path.join(sourcePath, item.name);
    if (shouldExcludePath(sourceItemPath, patterns, rootPath)) {
      continue;
    }

    const targetItemPath = path.join(targetPath, item.name);
    if (item.isDirectory()) {
      copyDirectoryWithExclusions(sourceItemPath, targetItemPath, patterns, rootPath);
    } else {
      fsOriginal.copyFileSync(sourceItemPath, targetItemPath);
    }
  }
}

function calculateBackupSourceSize(sourcePath: string, patterns = getBackupExclusionPatterns(), rootPath = sourcePath): number {
  try {
    if (!sourcePath || !fsOriginal.existsSync(sourcePath) || shouldExcludePath(sourcePath, patterns, rootPath)) {
      return 0;
    }

    const stats = fsOriginal.statSync(sourcePath);
    if (!stats.isDirectory()) {
      return stats.size;
    }

    let totalSize = 0;
    for (const child of fsOriginal.readdirSync(sourcePath)) {
      totalSize += calculateBackupSourceSize(path.join(sourcePath, child), patterns, rootPath);
    }
    return totalSize;
  } catch (error) {
    console.warn(`Failed to calculate backup source size: ${sourcePath}`, error);
    return 0;
  }
}

function applyBackupAnalysis(game: Game): Game {
  game.change_status = getBackupChangeStatus(game);
  game.size_warning = getBackupSizeWarning(game);
  return game;
}

function getBackupChangeStatus(game: Game, backupRoot = getSettings().backupPath): BackupChangeStatus {
  if (!game.resolved_paths || game.resolved_paths.length === 0) {
    return 'unchanged';
  }

  const latestBackupDate = getLatestBackupDate(game.wiki_page_id, backupRoot);
  if (!latestBackupDate) {
    return 'new';
  }

  const latestSaveMTime = getLatestResolvedPathMTime(game.resolved_paths);
  if (!latestSaveMTime) {
    return 'unchanged';
  }

  return latestSaveMTime.getTime() > latestBackupDate.getTime() ? 'updated' : 'unchanged';
}

function shouldAutoBackupGame(game: Game, backupRoot = getSettings().backupPath): boolean {
  return getBackupChangeStatus(game, backupRoot) !== 'unchanged';
}

function getLatestBackupDate(wikiPageId: string, backupRoot = getSettings().backupPath): Date | null {
  const latestBackup = getBackupHistory(wikiPageId, backupRoot)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return latestBackup?.createdAt || null;
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

function getBackupSizeWarning(game: Game, backupRoot = getSettings().backupPath): BackupSizeWarning | null {
  const settings = getSettings();
  if (settings?.backupSizeWarningEnabled === false || game.backup_size <= 0) {
    return null;
  }

  const absoluteThreshold = sanitizePositiveNumber(
    settings?.backupSizeWarningThresholdMb,
    DEFAULT_SIZE_WARNING_THRESHOLD_MB
  ) * 1024 * 1024;
  const multiplier = sanitizePositiveNumber(
    settings?.backupSizeWarningMultiplier,
    DEFAULT_SIZE_WARNING_MULTIPLIER
  );
  const historySizes = getBackupHistory(game.wiki_page_id, backupRoot)
    .map(entry => entry.size)
    .filter(size => Number.isFinite(size) && size > 0);

  if (historySizes.length > 0) {
    const referenceSize = median(historySizes);
    if (
      referenceSize > 0
      && game.backup_size >= referenceSize * multiplier
      && game.backup_size - referenceSize >= MIN_SIZE_WARNING_DELTA_BYTES
    ) {
      return {
        type: 'growth',
        current_size: game.backup_size,
        reference_size: referenceSize,
      };
    }
  }

  if (game.backup_size >= absoluteThreshold) {
    return {
      type: 'large',
      current_size: game.backup_size,
      reference_size: absoluteThreshold,
    };
  }

  return null;
}

function getBackupHistory(wikiPageId: string, backupRoot = getSettings().backupPath): BackupHistoryEntry[] {
  const gameBackupPath = path.join(backupRoot, wikiPageId.toString());
  if (!fsOriginal.existsSync(gameBackupPath)) {
    return [];
  }

  let backupEntries: Dirent[];
  try {
    backupEntries = fsOriginal.readdirSync(gameBackupPath, { withFileTypes: true });
  } catch (error) {
    console.warn(`Failed to inspect backup directory: ${gameBackupPath}`, error);
    return [];
  }

  const history: BackupHistoryEntry[] = [];
  for (const entry of backupEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const parsedDate = moment(entry.name, BACKUP_FOLDER_FORMAT, true);
    if (!parsedDate.isValid()) {
      continue;
    }

    const backupInstancePath = path.join(gameBackupPath, entry.name);
    const configPath = path.join(backupInstancePath, 'backup_info.json');
    let size = calculateBackupDirectorySize(backupInstancePath);
    let createdAt = parsedDate.toDate();

    try {
      if (fsOriginal.existsSync(configPath)) {
        const config = JSON.parse(fsOriginal.readFileSync(configPath, 'utf-8'));
        if (Number.isFinite(config.backup_total_size)) {
          size = Number(config.backup_total_size);
        }
        createdAt = new Date(Math.max(createdAt.getTime(), fsOriginal.statSync(configPath).mtime.getTime()));
      }
    } catch (error) {
      console.warn(`Failed to read backup metadata: ${configPath}`, error);
    }

    history.push({
      date: entry.name,
      path: backupInstancePath,
      size,
      createdAt,
    });
  }

  return history;
}

async function validateLatestBackupForGame(gameObj: any, backupRoot = getSettings().backupPath): Promise<BackupValidationResult> {
  const backupFolder = Array.isArray(gameObj?.backups) && gameObj.backups.length > 0
    ? [...gameObj.backups].sort((a, b) => b.date.localeCompare(a.date))[0]?.date
    : getBackupHistory(String(gameObj?.wiki_page_id), backupRoot).sort((a, b) => b.date.localeCompare(a.date))[0]?.date;

  if (!backupFolder) {
    return {
      valid: false,
      backup_path: '',
      checked_files: 0,
      missing_files: 0,
      errors: ['No backup found'],
      warnings: [],
    };
  }

  const backupPath = path.join(backupRoot, String(gameObj.wiki_page_id), backupFolder);
  return validateBackupInstance(backupPath);
}

async function validateBackupInstance(backupInstancePath: string): Promise<BackupValidationResult> {
  const result: BackupValidationResult = {
    valid: true,
    backup_path: backupInstancePath,
    checked_files: 0,
    missing_files: 0,
    errors: [],
    warnings: [],
  };

  const configPath = path.join(backupInstancePath, 'backup_info.json');
  if (!fsOriginal.existsSync(configPath)) {
    result.errors.push(`Missing backup_info.json: ${configPath}`);
    result.valid = false;
    return result;
  }

  let backupConfig: any;
  try {
    backupConfig = JSON.parse(fsOriginal.readFileSync(configPath, 'utf-8'));
  } catch (error) {
    result.errors.push(`Malformed backup_info.json: ${error instanceof Error ? error.message : String(error)}`);
    result.valid = false;
    return result;
  }

  if (!Array.isArray(backupConfig.backup_paths)) {
    result.errors.push('backup_info.json does not contain backup_paths');
    result.valid = false;
    return result;
  }

  for (const backupPathConfig of backupConfig.backup_paths) {
    const folderName = String(backupPathConfig.folder_name || '');
    const storedPath = path.join(backupInstancePath, folderName);
    if (!folderName || !fsOriginal.existsSync(storedPath)) {
      result.errors.push(`Missing backup path folder: ${storedPath}`);
      result.valid = false;
      continue;
    }

    if (backupPathConfig.type === 'reg') {
      const registryFile = path.join(storedPath, 'registry_backup.reg');
      result.checked_files += 1;
      if (!fsOriginal.existsSync(registryFile)) {
        result.missing_files += 1;
        result.errors.push(`Missing registry backup file: ${registryFile}`);
        result.valid = false;
      }
      continue;
    }

    const fileEntries = Array.isArray(backupPathConfig.files) ? backupPathConfig.files : [];
    if (fileEntries.length === 0) {
      result.warnings.push(`Legacy metadata without file manifest: ${storedPath}`);
      if (isDirectoryEmpty(storedPath)) {
        result.errors.push(`Backup path is empty: ${storedPath}`);
        result.valid = false;
      }
      continue;
    }

    for (const fileEntry of fileEntries) {
      const relativePath = String(fileEntry.relative_path || '');
      if (!relativePath) {
        result.warnings.push(`Skipping manifest entry with empty relative path in ${storedPath}`);
        continue;
      }

      const targetPath = path.join(storedPath, relativePath);
      result.checked_files += 1;
      if (!fsOriginal.existsSync(targetPath)) {
        result.missing_files += 1;
        result.errors.push(`Missing backup file: ${targetPath}`);
        result.valid = false;
        continue;
      }

      if (fileEntry.type === 'file') {
        const actualSize = fsOriginal.statSync(targetPath).size;
        if (Number.isFinite(fileEntry.size) && actualSize !== Number(fileEntry.size)) {
          result.errors.push(`Backup file size mismatch: ${targetPath}`);
          result.valid = false;
        }
      }
    }
  }

  return result;
}

function collectSourceManifestEntry(sourcePath: string, rootPath: string, patterns: string[], manifest: SourceManifest): void {
  try {
    if (!fsOriginal.existsSync(sourcePath)) {
      return;
    }

    const relativePath = getManifestRelativePath(rootPath, sourcePath);
    if (shouldExcludePath(sourcePath, patterns, rootPath)) {
      manifest.excluded.push(relativePath);
      return;
    }

    const stats = fsOriginal.statSync(sourcePath);
    if (stats.isDirectory()) {
      const childNames = fsOriginal.readdirSync(sourcePath);
      if (relativePath || childNames.length === 0) {
        manifest.files.push({
          relative_path: relativePath || '.',
          type: 'directory',
          size: 0,
          mtime_ms: stats.mtimeMs,
        });
      }
      const entryCountBeforeChildren = manifest.files.length;
      for (const child of childNames) {
        collectSourceManifestEntry(path.join(sourcePath, child), rootPath, patterns, manifest);
      }
      if (!relativePath && childNames.length > 0 && manifest.files.length === entryCountBeforeChildren) {
        manifest.files.push({
          relative_path: '.',
          type: 'directory',
          size: 0,
          mtime_ms: stats.mtimeMs,
        });
      }
      return;
    }

    const fileRelativePath = relativePath || path.basename(sourcePath);
    manifest.files.push({
      relative_path: fileRelativePath,
      type: 'file',
      size: stats.size,
      mtime_ms: stats.mtimeMs,
    });
    manifest.size += stats.size;
  } catch (error) {
    console.warn(`Failed to inspect source path: ${sourcePath}`, error);
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
    console.warn(`Failed to inspect backup path: ${targetPath}`, error);
    return null;
  }
}

function calculateBackupDirectorySize(directoryPath: string): number {
  try {
    if (!fsOriginal.existsSync(directoryPath)) {
      return 0;
    }

    const stats = fsOriginal.statSync(directoryPath);
    if (!stats.isDirectory()) {
      return stats.size;
    }

    let total = 0;
    for (const child of fsOriginal.readdirSync(directoryPath)) {
      if (child === 'backup_info.json') {
        continue;
      }
      total += calculateBackupDirectorySize(path.join(directoryPath, child));
    }
    return total;
  } catch (error) {
    console.warn(`Failed to inspect backup size: ${directoryPath}`, error);
    return 0;
  }
}

function getManifestRelativePath(rootPath: string, sourcePath: string): string {
  const relativePath = path.relative(rootPath, sourcePath);
  if (!relativePath) {
    return '';
  }
  return relativePath.split(path.sep).join('/');
}

function isDirectoryEmpty(directoryPath: string): boolean {
  try {
    return fsOriginal.statSync(directoryPath).isDirectory() && fsOriginal.readdirSync(directoryPath).length === 0;
  } catch {
    return true;
  }
}

function normalizeForMatch(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '').toLowerCase();
}

function globMatches(value: string, pattern: string): boolean {
  return globPatternToRegex(pattern).test(value);
}

function globPatternToRegex(pattern: string): RegExp {
  let regex = '^';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    const nextChar = pattern[index + 1];

    if (char === '*' && nextChar === '*') {
      const afterNext = pattern[index + 2];
      if (afterNext === '/') {
        regex += '(?:.*/)?';
        index += 2;
      } else {
        regex += '.*';
        index += 1;
      }
      continue;
    }

    if (char === '*') {
      regex += '[^/]*';
    } else if (char === '?') {
      regex += '[^/]';
    } else {
      regex += escapeRegExp(char);
    }
  }
  regex += '$';
  return new RegExp(regex);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function sanitizePositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

export {
  BACKUP_FOLDER_FORMAT,
  applyBackupAnalysis,
  calculateBackupSourceSize,
  collectSourceManifest,
  copyDirectoryWithExclusions,
  getBackupChangeStatus,
  getBackupExclusionPatterns,
  getBackupHistory,
  getBackupSizeWarning,
  getLatestBackupDate,
  getLatestResolvedPathMTime,
  shouldAutoBackupGame,
  shouldExcludePath,
  validateBackupInstance,
  validateLatestBackupForGame,
};
