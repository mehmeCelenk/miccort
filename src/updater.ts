declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export async function checkForAppUpdates() {
  if (!window.__TAURI_INTERNALS__) {
    return;
  }

  try {
    const [{ check }, { relaunch }] = await Promise.all([
      import('@tauri-apps/plugin-updater'),
      import('@tauri-apps/plugin-process'),
    ]);

    const update = await check();
    if (!update) {
      return;
    }

    await update.downloadAndInstall();
    const shouldRestart = window.confirm(
      `Mikcort ${update.version} has been installed. Restart now to use the updated app?`,
    );
    if (shouldRestart) {
      await relaunch();
    }
  } catch (err) {
    console.warn('Update check failed', err);
  }
}
