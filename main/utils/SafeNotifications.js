import { Platform } from 'react-native';
import notifee from 'react-native-notify-kit';

//AuthorizationStatus values, inlined rather than imported: the web/electron
//build aliases this module to a mock that only has a default export, so the
//named import would come back undefined and blow up on first use.
const AUTHORIZED = 1;
const PROVISIONAL = 2;

//Notifications are a nice-to-have, never a requirement.
//On iOS the OS never grants authorisation implicitly, and sandboxed
//environments (LiveContainer, TrollStore, some sideload setups) can't grant it
//at all. notifee then rejects every displayNotification call, which used to
//take the whole download queue and the library updater down with it.
//Everything here swallows its errors so a missing notification can only ever
//cost you a notification.

let permissionPromise = null;
let notificationsDisabled = false;

//A native promise that never settles (the permission alert can't be presented
//inside a guest container, or the module is half-loaded) must not be allowed to
//wedge anything that awaits us. Race it against a clock and treat a timeout as
//"not authorised".
const PERMISSION_TIMEOUT_MS = 8000;

function withTimeout(promise, ms, fallback) {
  let timer;
  const clock = new Promise(resolve => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, clock]).finally(() => clearTimeout(timer));
}

function warn(action, error) {
  console.warn(
    `[Notifications] ${action} failed, continuing without it:`,
    error?.message ?? error,
  );
}

//Asks once per app run and caches the answer.
export async function ensureNotificationPermission() {
  if (!permissionPromise) {
    permissionPromise = (async () => {
      try {
        const settings = await withTimeout(
          notifee.requestPermission(),
          PERMISSION_TIMEOUT_MS,
          null,
        );
        if (settings === null) {
          console.warn('[Notifications] permission request timed out.');
          return false;
        }
        const status = settings?.authorizationStatus;
        return status === AUTHORIZED || status === PROVISIONAL;
      } catch (e) {
        warn('requestPermission', e);
        return false;
      }
    })();
  }
  return permissionPromise;
}

export async function safeCreateChannel(channel) {
  if (notificationsDisabled) return channel?.id ?? '';
  try {
    return await notifee.createChannel(channel);
  } catch (e) {
    warn('createChannel', e);
    return channel?.id ?? '';
  }
}

export async function safeDisplayNotification(notification) {
  if (notificationsDisabled) return null;

  //Only iOS refuses the post outright without authorisation. On Android a
  //denied POST_NOTIFICATIONS silently drops the notification from the shade
  //but still starts a foreground service attached to it, and the library
  //updater depends on exactly that to survive the headless timeout. So the
  //permission gate, and the latch below, are iOS-only.
  if (Platform.OS === 'ios' && !(await ensureNotificationPermission())) {
    notificationsDisabled = true;
    console.log(
      '[Notifications] not authorised, running silently for this session.',
    );
    return null;
  }

  try {
    return await withTimeout(
      notifee.displayNotification(notification),
      PERMISSION_TIMEOUT_MS,
      null,
    );
  } catch (e) {
    if (Platform.OS === 'ios') notificationsDisabled = true;
    warn('displayNotification', e);
    return null;
  }
}

export async function safeCancelNotification(notificationId) {
  if (notificationsDisabled) return;
  try {
    await notifee.cancelNotification(notificationId);
  } catch (e) {
    warn('cancelNotification', e);
  }
}

export async function safeStopForegroundService() {
  try {
    await notifee.stopForegroundService();
  } catch (e) {
    warn('stopForegroundService', e);
  }
}
