const appStatus = {
    backuping: false,
    auto_backuping: false,
    restoring: false,
    migrating: false,
    updating_db: false
};

type AppStatusKey = keyof typeof appStatus;

const getAppStatus = () => appStatus;

const updateAppStatus = (statusKey: AppStatusKey, statusValue: boolean) => {
    appStatus[statusKey] = statusValue;
};

export {
    getAppStatus,
    updateAppStatus,
};
export type { AppStatusKey };
