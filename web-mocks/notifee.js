//Shape mirrors react-native-notify-kit's public surface: a default module plus
//the named enums consumers import. The named exports matter -- DownloadManager
//and the updater import AndroidImportance by name, and `undefined.LOW` used to
//throw inside processQueue on web, which quietly killed the download queue.
export const AuthorizationStatus = {
  NOT_DETERMINED: -1,
  DENIED: 0,
  AUTHORIZED: 1,
  PROVISIONAL: 2,
};

export const AndroidImportance = {
  NONE: 0,
  MIN: 1,
  LOW: 2,
  DEFAULT: 3,
  HIGH: 4,
};

export const AndroidStyle = {
  BIGPICTURE: 0,
  BIGTEXT: 1,
  INBOX: 2,
  MESSAGING: 3,
};

export const AndroidForegroundServiceType = {
  FOREGROUND_SERVICE_TYPE_DATA_SYNC: 1,
};

export const EventType = {
  DISMISSED: 0,
  PRESS: 1,
  DELIVERED: 2,
};

export default {
  displayNotification: async (notification) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(notification.title || '', { body: notification.body });
    }
    return '';
  },
  requestPermission: async () => ({
    authorizationStatus:
      'Notification' in window && Notification.permission === 'granted'
        ? AuthorizationStatus.AUTHORIZED
        : AuthorizationStatus.DENIED,
  }),
  createChannel: async () => 'default',
  cancelNotification: async () => {},
  stopForegroundService: async () => {},
  registerForegroundService: () => {},
  getInitialNotification: async () => null,
  onBackgroundEvent: () => {},
  onForegroundEvent: () => () => {},
  EventType,
  AndroidImportance,
  AndroidStyle,
  AuthorizationStatus,
};
