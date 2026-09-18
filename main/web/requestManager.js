import ky, { TimeoutError } from 'ky';
import { BROWSER_HEADERS } from './userAgent';
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

  //No Cloudflare "mode" latch any more. It used to route EVERY request through
  //the WebView for 24h after a single challenge, so one bad moment meant AO3's
  //Cloudflare page on every screen until it expired - including when a plain
  //request would have succeeded. The direct fetch is always tried first now and
  //the WebView is only used for the request that actually got challenged.
  try {
    const html = await ky.get(url, {
      headers: BROWSER_HEADERS,
      //ky defaults to a 10s timeout, and AO3 on mobile exceeds that routinely.
      //Every one of those timeouts was caught below and sent to the WebView,
      //which is how ordinary slowness ended up rendering a Cloudflare page.
      timeout: 60000,
      //Default is 2. Combined with the timeout above, a 503 could burn three
      //full attempts before the caller ever heard back.
      retry: 1,
    }).text();

    if (isCFChallenge(html)) {
      console.log(`isCfChalenged fiered with ${html}`);
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
      return fetchViaWebView(url);
    }
    if (err instanceof TimeoutError) {
      return fetchViaWebView(url);
    }
    throw err;
  }
}