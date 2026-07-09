declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

type UpdateStatus = 'checking' | 'available' | 'not-available' | 'installed' | 'error';

export type UpdateStatusEvent = CustomEvent<{
  status: UpdateStatus;
  message: string;
}>;

export async function checkForAppUpdates() {
  if (!window.__TAURI_INTERNALS__) {
    return;
  }

  try {
    emitUpdateStatus('checking', 'Checking for updates...');
    const [{ check }, { relaunch }] = await Promise.all([
      import('@tauri-apps/plugin-updater'),
      import('@tauri-apps/plugin-process'),
    ]);

    const update = await check();
    if (!update) {
      emitUpdateStatus('not-available', 'Mikcort is up to date.');
      return;
    }

    emitUpdateStatus('available', `Downloading Mikcort ${update.version}...`);
    await update.downloadAndInstall();
    emitUpdateStatus('installed', `Mikcort ${update.version} is ready to install.`);
    const shouldRestart = window.confirm(
      `Mikcort ${update.version} has been installed. Restart now to use the updated app?`,
    );
    if (shouldRestart) {
      await relaunch();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Update check failed.';
    emitUpdateStatus('error', message);
    console.warn('Update check failed', err);
  }
}

function emitUpdateStatus(status: UpdateStatus, message: string) {
  window.dispatchEvent(
    new CustomEvent('mikcort:update-status', {
      detail: { status, message },
    }),
  );
}
