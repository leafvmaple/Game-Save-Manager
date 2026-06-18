import { app } from 'electron';
import path from 'path';

const getRootPath = () => {
  return app.isPackaged
    ? path.join(__dirname, '../../')
    : path.join(__dirname, '../..');
};

const getAssetPath = (...paths: string[]) => {
  return path.join(getRootPath(), 'assets', ...paths);
};

const getLocalePath = (...paths: string[]) => {
  return path.join(getRootPath(), 'locales', ...paths);
};

const getRenderPath = (...paths: string[]) => {
  return path.join(getRootPath(), "src", 'renderer', ...paths);
};

const getBundledDatabasePath = () => {
  return app.isPackaged
    ? path.join(path.dirname(process.execPath), 'database', 'database.db')
    : path.join(getRootPath(), 'database', 'database.db');
};

export {
  getRootPath,
  getAssetPath,
  getLocalePath,
  getRenderPath,
  getBundledDatabasePath
};
