import { fetchChapter } from '../web/worksScreen/fetchChapter';
import RNFS from 'react-native-fs';
import { DeviceEventEmitter } from 'react-native';

export function buildPath(workId, chapterId) {
  return `${RNFS.DocumentDirectoryPath}/CO3/downloads/${workId}/${chapterId}`;
}

export async function downloadChapter(workId, chapterId) {
  //No noWebview here. That flag exists for Android's headless updater, which
  //has no UI to host a WebView. Downloads are always started from a screen,
  //and passing it skipped the Cloudflare-mode WebView path that every other
  //read in the app relies on, so in anti-bot mode chapters failed while
  //browsing and kudos kept working.
  const chapter = await fetchChapter(workId, chapterId);

  //fetchChapter returns null when it can't find the work body, which used to
  //surface as "null is not iterable" from the destructuring below.
  if (!chapter) {
    throw new Error(
      `No chapter content found for chapter ${chapterId} of work ${workId}`,
    );
  }

  const [html, css] = chapter;
  await saveFile(html, css, workId, chapterId);
}

const saveFile = async (html, css, workId, chapterId) => {
  const path = buildPath(workId, chapterId);

  try {
    await RNFS.mkdir(`${RNFS.DocumentDirectoryPath}/CO3/`);
    await RNFS.mkdir(`${RNFS.DocumentDirectoryPath}/CO3/downloads/`);
    await RNFS.mkdir(`${RNFS.DocumentDirectoryPath}/CO3/downloads/${workId}/`);

    await RNFS.writeFile(path + ".html", html, 'utf8');
    await RNFS.writeFile(path + ".css", css, 'utf8');
    console.log(`Download successful ${chapterId} from work ${workId} to ${path}.html and .css`);
  } catch (err) {
    //This used to be swallowed, so a chapter that failed to write still
    //reported as downloaded and the queue happily moved on.
    console.error(`Failed to save chapter ${chapterId} of work ${workId}:`, err);
    throw err;
  }
};

export async function isDownloaded(workId, chapterId) {
  const path = buildPath(workId, chapterId);
  return await RNFS.exists(path + ".html") && await RNFS.exists(path + ".css");
}

export const getDownloaded = async (workId, chapterId) => {
  const path = buildPath(workId, chapterId);
  return [
    await RNFS.readFile(path + ".html", 'utf8'),
    await RNFS.readFile(path + '.css', 'utf8'),
  ];
}

export const deleteDownloaded = async (workId, chapterId) => {
  try {
    const path = buildPath(workId, chapterId);
    await RNFS.unlink(path + '.html');
    await RNFS.unlink(path + '.css');
    DeviceEventEmitter.emit('chapter_deleted', {
      chapterId: String(chapterId),
      success: true,
    });
  } catch (err) {
    DeviceEventEmitter.emit('chapter_deleted', {
      chapterId: String(chapterId),
      success: false,
    });
  }
}

export async function countDownloads() {
  const downloadsPath = `${RNFS.DocumentDirectoryPath}/CO3/downloads`;

  const exists = await RNFS.exists(downloadsPath);
  if (!exists) return { folderCount: 0, fileCount: 0, chapterCount: 0 };

  const workFolders = await RNFS.readDir(downloadsPath);
  const dirs = workFolders.filter(f => f.isDirectory());

  const counts = await Promise.all(
    dirs.map(folder => RNFS.readDir(folder.path).then(files => files.length)),
  );

  const fileCount = counts.reduce((sum, n) => sum + n, 0);

  return { folderCount: dirs.length, fileCount, chapterCount: fileCount / 2 };
}

export async function deleteAllDownloads() {
  const dlPath = `${RNFS.DocumentDirectoryPath}/CO3/downloads/`
  return await RNFS.unlink(dlPath)
    .then(() => {
      return undefined;
    })
    .catch(error => {
      return error;
    });
}
