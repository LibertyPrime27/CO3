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
        const settings = await notifee.requestPermission();
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

//True once we know notifications can't be shown, so a 400 chapter queue
//doesn't fire 400 doomed native calls.
export function notificationsAvailable() {
  return !notificationsDisabled;
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

  if (!(await ensureNotificationPermission())) {
    notificationsDisabled = true;
    console.log(
      '[Notifications] not authorised, running silently for this session.',
    );
    return null;
  }

  try {
    return await notifee.displayNotification(notification);
  } catch (e) {
    notificationsDisabled = true;
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
