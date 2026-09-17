import RNFS from 'react-native-fs';
import { Platform } from 'react-native';

//RNFS only exports DownloadDirectoryPath on Android. On iOS it is undefined,
//which silently turns a destination into the relative path "undefined/foo.epub"
//and every write fails. Anything saving a user facing file goes through here.
export function getSaveDirectory() {
  return Platform.select({
    android: RNFS.DownloadDirectoryPath,
    ios: RNFS.DocumentDirectoryPath,
    default: RNFS.DocumentDirectoryPath,
  });
}

export function getSavePath(filename) {
  return `${getSaveDirectory()}/${filename}`;
}
