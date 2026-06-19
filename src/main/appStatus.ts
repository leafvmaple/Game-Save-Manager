const appStatus = {
    backuping: false,
    auto_backuping: false,
    restoring: false,
    migrating: false,
    updating_db: false
};

type AppStatusKey = keyof typeof appStatus;

const appStatusKeys = Object.keys(appStatus) as AppStatusKey[];
const lockedStatusKeys = new Set<AppStatusKey>();

class AppStatusBusyError extends Error {
    activeStatusKeys: AppStatusKey[];

    constructor(activeStatusKeys: AppStatusKey[]) {
        super(`Application is busy: ${activeStatusKeys.join(', ')}`);
        this.name = 'AppStatusBusyError';
        this.activeStatusKeys = activeStatusKeys;
    }
}

const getAppStatus = () => ({ ...appStatus });

const getActiveAppStatusKeys = (ignoredStatusKeys: AppStatusKey[] = []): AppStatusKey[] => {
    return appStatusKeys.filter(statusKey => appStatus[statusKey] && !ignoredStatusKeys.includes(statusKey));
};

const isAppBusy = (ignoredStatusKeys: AppStatusKey[] = []) => {
    return getActiveAppStatusKeys(ignoredStatusKeys).length > 0;
};

const updateAppStatus = (statusKey: AppStatusKey, statusValue: boolean): boolean => {
    if (!statusValue && lockedStatusKeys.has(statusKey)) {
        return false;
    }
    appStatus[statusKey] = statusValue;
    return true;
};

const withAppStatus = async <T>(statusKey: AppStatusKey, operation: () => Promise<T>): Promise<T> => {
    const lockedStatusKey = [...lockedStatusKeys][0];
    if (lockedStatusKey) {
        throw new AppStatusBusyError([lockedStatusKey]);
    }

    const activeStatusKeys = getActiveAppStatusKeys([statusKey]);
    if (activeStatusKeys.length > 0) {
        throw new AppStatusBusyError(activeStatusKeys);
    }

    const previousStatusValue = appStatus[statusKey];
    lockedStatusKeys.add(statusKey);
    appStatus[statusKey] = true;

    try {
        return await operation();
    } finally {
        lockedStatusKeys.delete(statusKey);
        if (!previousStatusValue) {
            appStatus[statusKey] = false;
        }
    }
};

export {
    AppStatusBusyError,
    getActiveAppStatusKeys,
    getAppStatus,
    isAppBusy,
    updateAppStatus,
    withAppStatus,
};
export type { AppStatusKey };
