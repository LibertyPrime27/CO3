import ky, { TimeoutError } from 'ky';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchViaWebView } from './WebviewFetcher';
import { Platform } from 'react-native';
import {
  deleteCredsPasswd,
  deleteCredsToken,
  deleteLastLogin,
  getCredsPasswd,
  getLastLogin,
  getUsername,
  hasStoredPassword,
  hasStoredToken,
  setLastLogin,
} from '../storage/Credentials';
import Toast from 'react-native-toast-message';
import { navigationRef } from '../app';
import { handleLogin } from './account/login';

const CF_STORAGE_KEY = 'cf_domains';
const CF_MODE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

async function getCFMap() {
  const raw = await AsyncStorage.getItem(CF_STORAGE_KEY);
  return raw ? JSON.parse(raw) : {};
}

async function isCFMode(domain) {
  const map = await getCFMap();
  if (!map[domain]) return false;
  if (Date.now() > map[domain]) {
    delete map[domain];
    await AsyncStorage.setItem(CF_STORAGE_KEY, JSON.stringify(map));
    return false;
  }
  return true;
}

async function enableCFMode(domain) {
  const map = await getCFMap();
  map[domain] = Date.now() + CF_MODE_DURATION;
  await AsyncStorage.setItem(CF_STORAGE_KEY, JSON.stringify(map));
}

const TIMEOUT_STRIKE_KEY = 'cf_timeout_strikes';
const TIMEOUT_STRIKES_BEFORE_CF = 3;
const TIMEOUT_STRIKE_WINDOW = 10 * 60 * 1000; // 10 minutes

//Returns true once a host has timed out enough times in a short window that
//Cloudflare is the likely explanation rather than one slow page.
async function recordTimeoutStrike(domain) {
  try {
    const raw = await AsyncStorage.getItem(TIMEOUT_STRIKE_KEY);
    const map = raw ? JSON.parse(raw) : {};
    const now = Date.now();
    const entry = map[domain];
    const fresh = entry && now - entry.first < TIMEOUT_STRIKE_WINDOW;

    const count = fresh ? entry.count + 1 : 1;
    map[domain] = { count, first: fresh ? entry.first : now };
    await AsyncStorage.setItem(TIMEOUT_STRIKE_KEY, JSON.stringify(map));

    if (count >= TIMEOUT_STRIKES_BEFORE_CF) {
      delete map[domain];
      await AsyncStorage.setItem(TIMEOUT_STRIKE_KEY, JSON.stringify(map));
      return true;
    }
    return false;
  } catch (e) {
    console.warn('Could not record a timeout strike:', e);
    return false;
  }
}

function isCFChallenge(html) {
  return html.includes('_cf_chl_opt');
}

const cloudflareErrorCodes = [
  403, //Unauthorized
  525, //Supposed to be an SSL error but CF uses it to block automated request sometimes
  418, //Don't ask me why, I did have an encounter with CF and this error code using tor exit nodes
  520, //CF specific, "Unknown error"
  522, //CF specific, "Connection Timed Out"
  503, //Used for CF challenges
]

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

//getLastLogin() hands back an ISO date STRING, not a number. The old check did
//`Date.now() - time > TWO_WEEKS`, which is NaN for a string (never fires) and
//`Date.now()` itself when the value is null (always fires). So the only time it
//ever triggered was when no timestamp was stored at all, which is exactly the
//state a fresh install or a sandboxed Keychain is in. That is why downloading a
//chapter announced "You have been logged out !" -- this branch only runs for
//downloads, which is why kudos and browsing were unaffected.
async function checkLoginAge() {
  //Nothing to expire if the user was never logged in. Downloading public works
  //anonymously is perfectly valid, so don't nag about it.
  if (!(await hasStoredToken())) return false;

  const lastLogin = await getLastLogin();
  const lastLoginMs = lastLogin ? Date.parse(lastLogin) : NaN;

  if (Number.isNaN(lastLoginMs)) {
    //Logged in but with no usable timestamp. Self-heal rather than claiming an
    //expiry we can't actually prove.
    await setLastLogin();
    return false;
  }

  return Date.now() - lastLoginMs > TWO_WEEKS_MS;
}

export default async function getUrl(url, noWebview = false) {
  const { hostname } = new URL(url);

  if (noWebview) {
    checkLoginAge().then(async (expired) => {
      try {
        if (expired) {
          Toast.show(
            {
              type: 'error',
              text1: "You have been logged out !",
              text2: "It's been two week since you last logged in.",
              onPress: async () => {
                if (await hasStoredPassword()) {
                  try {
                    await handleLogin(await getUsername(), await getCredsPasswd());
                  } catch (e) {
                    Toast.show({
                      type: 'error',
                      text1: "Login failed.",
                      text2: e,
                      onPress: () => {
                        navigationRef.navigate("Account", {});
                      }
                    })

                    deleteLastLogin();
                    deleteCredsPasswd();
                    deleteCredsToken();
                  }
                } else {
                  navigationRef.navigate("Account", {});
                }
              }
            }
          )

          //No automatic wipe here any more. deleteCredsToken() runs
          //CookieManager.clearAll(), which also throws away cf_clearance and
          //leaves every later request stuck behind Cloudflare. Tearing a
          //session down from inside a GET helper, on a hasStoredPassword()
          //that returns false on any Keychain hiccup, is how a download made
          //the whole app log out. The toast above still offers re-login.
        }
      } catch (error) {
        console.error(error);
      }
    })
  }

  if (!(Platform.OS === 'ios' || Platform.OS === 'android')) {
    noWebview = true;
  }

  if (!noWebview && await isCFMode(hostname)) {
    console.log(`using webview to fetch ${url}`);
    return fetchViaWebView(url);
  }

  try {
    const html = await ky.get(url).text();

    if (isCFChallenge(html)) {
      console.log(`isCfChalenged fiered with ${html}`);
      await enableCFMode(hostname);
      //No cfWarning. That flag routed the WebView into a modal instead of showing
      //the challenge: the warning appeared, the WebView stayed hidden so Cloudflare
      //was never actually presented or solved, and dismissing it reloaded the same
      //URL straight back into the same challenge. Without it the WebView is shown,
      //the challenge resolves, and the page loads.
      return fetchViaWebView(url);
    }

    console.log(`fetched ${url} via ky.`);
    return html;
  } catch (err) {
    if (cloudflareErrorCodes.includes(err?.response?.status)) {
      await enableCFMode(hostname);
      return fetchViaWebView(url);
    }
    if (err instanceof TimeoutError) {
      //A timeout is not proof of Cloudflare. Bulk chapter downloads are by far
      //the most timeout-prone thing the app does, and one slow chapter used to
      //be enough to put every request in the app behind the WebView for 24h -
      //which silently moved the kudo token onto a different session than the
      //POST that uses it. Retry through the WebView for this request only, and
      //make it take a few strikes before it becomes the app-wide mode.
      if (await recordTimeoutStrike(hostname)) {
        await enableCFMode(hostname);
      }
      return fetchViaWebView(url);
    }
    throw err;
  }
}