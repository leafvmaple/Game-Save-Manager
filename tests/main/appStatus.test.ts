import { beforeEach, describe, expect, it } from 'vitest';

import {
  AppStatusBusyError,
  getAppStatus,
  updateAppStatus,
  withAppStatus,
} from '../../src/main/appStatus';
import type { AppStatusKey } from '../../src/main/appStatus';

const statusKeys: AppStatusKey[] = ['backuping', 'auto_backuping', 'restoring', 'migrating', 'updating_db'];

describe('app status lock', () => {
  beforeEach(() => {
    for (const statusKey of statusKeys) {
      updateAppStatus(statusKey, false);
    }
  });

  it('sets and clears a status around an async operation', async () => {
    await withAppStatus('backuping', async () => {
      expect(getAppStatus().backuping).toBe(true);
      return null;
    });

    expect(getAppStatus().backuping).toBe(false);
  });

  it('clears the status when an operation throws', async () => {
    await expect(withAppStatus('restoring', async () => {
      throw new Error('restore failed');
    })).rejects.toThrow('restore failed');

    expect(getAppStatus().restoring).toBe(false);
  });

  it('blocks operations while another status is active', async () => {
    updateAppStatus('backuping', true);

    await expect(withAppStatus('restoring', async () => null)).rejects.toMatchObject({
      activeStatusKeys: ['backuping'],
    });
  });

  it('prevents concurrent reentry for the same locked status', async () => {
    await withAppStatus('backuping', async () => {
      await expect(withAppStatus('backuping', async () => null)).rejects.toBeInstanceOf(AppStatusBusyError);
    });
  });

  it('preserves a renderer-owned status after the locked operation finishes', async () => {
    updateAppStatus('backuping', true);

    await withAppStatus('backuping', async () => {
      expect(getAppStatus().backuping).toBe(true);
    });

    expect(getAppStatus().backuping).toBe(true);
  });

  it('does not let renderer updates clear a locked status', async () => {
    await withAppStatus('updating_db', async () => {
      expect(updateAppStatus('updating_db', false)).toBe(false);
      expect(getAppStatus().updating_db).toBe(true);
    });

    expect(getAppStatus().updating_db).toBe(false);
  });
});
