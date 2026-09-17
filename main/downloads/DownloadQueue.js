import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter } from 'react-native'; // Import this

const QUEUE_KEY = 'downloadQueue';

export async function getDownloadQueue() {
  try {
    const queueData = await AsyncStorage.getItem(QUEUE_KEY);
    return queueData ? JSON.parse(queueData) : [];
  } catch (error) {
    console.error('Error getting downloadQueue:', error);
    return [];
  }
}

export async function addToDownloadQueue(items) {
  try {
    const currentQueue = await getDownloadQueue();
    const itemsToAdd = Array.isArray(items) ? items : [items];

    const newQueue = [...currentQueue];
    itemsToAdd.forEach(newItem => {
      const exists = newQueue.find(q =>
        q.workId === newItem.workId && q.chapterId === newItem.chapterId
      );
      if (!exists) newQueue.push(newItem);
    });

    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(newQueue));

    DeviceEventEmitter.emit('queue_updated', newQueue);

    return newQueue;
  } catch (error) {
    console.error('Error adding to downloadQueue:', error);
  }
}

//Removes one specific item wherever it sits, rather than shifting the head, so
//cancelling the chapter currently being fetched can't knock the wrong entry off
//the front of the queue.
export async function removeFromDownloadQueue(workId, chapterId) {
  try {
    const queue = await getDownloadQueue();
    const newQueue = queue.filter(
      q =>
        !(
          String(q.workId) === String(workId) &&
          String(q.chapterId) === String(chapterId)
        ),
    );

    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(newQueue));
    DeviceEventEmitter.emit('queue_updated', newQueue);

    return newQueue;
  } catch (error) {
    console.error('Error removing from downloadQueue:', error);
    return null;
  }
}

export async function clearDownloadQueue() {
  try {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([]));
    DeviceEventEmitter.emit('queue_updated', []);
  } catch (error) {
    console.error('Error clearing downloadQueue:', error);
  }
}
