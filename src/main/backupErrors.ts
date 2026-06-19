import i18next from 'i18next';

function handleBackupError(error: unknown, contextMessage: string, errors: string[]): void {
  if (error instanceof Error) {
    console.error(`${contextMessage}: ${error.stack}`);
    errors.push(`${i18next.t('alert.backup_process_error_display')}: ${error.message}`);
  } else {
    console.error(`${contextMessage}: Unknown error`);
    errors.push(i18next.t('alert.backup_process_error_display'));
  }
}

export {
  handleBackupError,
};
