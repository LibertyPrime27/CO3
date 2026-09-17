import { AndroidImportance } from 'react-native-notify-kit';
import {
  safeCancelNotification,
  safeCreateChannel,
  safeDisplayNotification,
} from '../utils/SafeNotifications';
import {
  clearDownloadQueue,
  getDownloadQueue,
  removeFromDownloadQueue,
} from './DownloadQueue';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter } from 'react-native';
import { downloadChapter, isDownloaded } from './Downloader';
import { getJsonSettings } from '../storage/jsonSettings';

const FAILED_LIST_KEY = 'failedDownloads';
const CHANNEL_ID = 'download_channel';
const NOTIFICATION_ID = 'download_progress';

//A chapter is a few hundred KB of HTML. If it hasn't arrived in this long,
//something upstream is wedged (a Cloudflare interstitial nobody can see, a
//WebView that never settled) and the user deserves a failure they can retry,
//not a spinner that runs until the app is killed.
const DOWNLOAD_TIMEOUT_MS = 90 * 1000;

let isProcessing = false;
let currentKey = null;
const cancelledKeys = new Set();

const keyOf = (workId, chapterId) => `${workId}:${chapterId}`;

// Helper function for the delay
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, message) {
  let timer;
  const clock = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, clock]).finally(() => clearTimeout(timer));
}

class DownloadCancelled extends Error {
  constructor() {
    super('Download cancelled');
    this.name = 'DownloadCancelled';
  }
}

//Cancelling drops the item from the queue. If it is the one being fetched
//right now the network call can't be aborted, but its result is discarded and
//it is not recorded as a failure.
export async function cancelDownload(workId, chapterId) {
  const key = keyOf(workId, chapterId);
  if (currentKey === key) cancelledKeys.add(key);
  await removeFromDownloadQueue(workId, chapterId);
}

export async function cancelAllDownloads() {
  const queue = await getDownloadQueue();
  if (currentKey) cancelledKeys.add(currentKey);
  await clearDownloadQueue();
  return queue.length;
}

async function downloadTask(item) {
  const key = keyOf(item.workId, item.chapterId);
  try {
    const minDelay = 1500;
    const maxDelay = 4000;
    const randomDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1) + minDelay);

    if (await isDownloaded(item.workId, item.chapterId)) {
      console.log(`Chapter ${item.chapterId} from work ${item.workId} is already downloaded. Skipping...`);
      return;
    }

    console.log(`Waiting ${randomDelay}ms before downloading: ${item.chapterId}`);

    await sleep(randomDelay);

    if (cancelledKeys.has(key)) throw new DownloadCancelled();

    console.log(`Starting download for: ${item.chapterId}`);

    await withTimeout(
      downloadChapter(item.workId, item.chapterId),
      DOWNLOAD_TIMEOUT_MS,
      `Timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s waiting for AO3`,
    );

    DeviceEventEmitter.emit('download_completed', {
      chapterId: String(item.chapterId),
      success: true,
    });
    return true;
  } catch (e) {
    const cancelled = e instanceof DownloadCancelled;
    if (!cancelled) console.error(`Error downloading ${item.chapterId}:`, e);

    DeviceEventEmitter.emit('download_completed', {
      chapterId: String(item.chapterId),
      success: false,
      cancelled,
    });
    throw e;
  }
}

export async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;

  let failedCount = 0;
  let successCount = 0;
  let cancelledCount = 0;

  //"Background downloads" off means notifee is never touched from here. It is
  //the escape hatch for sandboxed installs where the notification module
  //itself misbehaves.
  const settings = await getJsonSettings();
  const notify = settings.backgroundDownloads !== false;

  try {
    let queue = await getDownloadQueue();
    let initialTotal = queue.length;
    let processed = 0;

    if (initialTotal === 0) {
      isProcessing = false;
      return;
    }

    //Notification calls below are deliberately not awaited. They are
    //decoration; the chapter fetch must never sit behind them, and the safe
    //wrappers never reject so there is nothing to catch.
    if (notify) {
      safeCreateChannel({
        id: CHANNEL_ID,
        name: 'Downloads',
        importance: AndroidImportance.LOW,
      });
    }

    while (true) {
      queue = await getDownloadQueue();
      if (queue.length === 0) break;

      const item = queue[0];
      const key = keyOf(item.workId, item.chapterId);
      currentKey = key;

      const currentTotal = processed + queue.length;
      if (currentTotal > initialTotal) initialTotal = currentTotal;

      if (notify) {
        safeDisplayNotification({
          id: NOTIFICATION_ID,
          title: 'Downloading Chapters',
          body: `Processing item ${processed + 1} of ${initialTotal}`,
          android: {
            channelId: CHANNEL_ID,
            ongoing: true,
            onlyAlertOnce: true,
            progress: {
              max: initialTotal,
              current: processed,
              indeterminate: false
            },
          },
        });
      }

      try {
        await downloadTask(item);
        successCount++;
      } catch (error) {
        if (error instanceof DownloadCancelled) {
          cancelledCount++;
        } else {
          console.error(`Download failed:`, error);
          failedCount++;
          //Keep the error type too. "Network request failed" and a 403 from
          //Cloudflare deserve to look different to whoever reads the report.
          const reason = error?.name && error.name !== 'Error'
            ? `${error.name}: ${error?.message ?? String(error)}`
            : error?.message ?? String(error);
          await handleDownloadFailure(item, reason);
        }
      } finally {
        cancelledKeys.delete(key);
        currentKey = null;
        await removeFromDownloadQueue(item.workId, item.chapterId);
        processed++;
      }
    }

  } catch (error) {
    console.error("Manager Critical Error:", error);
  } finally {
    isProcessing = false;
    currentKey = null;

    if (notify) {
      safeCancelNotification(NOTIFICATION_ID);

      if (failedCount > 0 || successCount > 0) {
        safeDisplayNotification({
          id: 'download_summary', // Different ID so it doesn't get cancelled
          title: failedCount > 0 ? 'Download Finished with Errors' : 'Downloads Complete',
          body: `${successCount} succeeded, ${failedCount} failed${cancelledCount ? `, ${cancelledCount} cancelled` : ''}.`,
          android: { channelId: CHANNEL_ID },
        });
      }
    }
  }
}

async function handleDownloadFailure(item, reason) {
  try {
    const failedJson = await AsyncStorage.getItem(FAILED_LIST_KEY);
    const failedList = failedJson ? JSON.parse(failedJson) : [];

    failedList.push({ ...item, failedAt: Date.now(), reason });
    await AsyncStorage.setItem(FAILED_LIST_KEY, JSON.stringify(failedList));

    DeviceEventEmitter.emit('failures_updated', failedList);
  } catch (e) {
    console.warn("Storage Error", e);
  }
}
