import ky from 'ky';
import { Platform } from 'react-native';
import getUrl from '../requestManager';
import { BROWSER_HEADERS, BROWSER_UA } from '../userAgent';

let DomParser = require('react-native-html-parser').DOMParser;

export async function fetchLoginAuthenticityToken() {
  try {
    let html = await ky.get("https://archiveofourown.org/users/login", { headers: BROWSER_HEADERS }).text();
    html = html.replace("<br \\>", ''); //Before you ask, no. I don't know. I don't need them anyway. /shrug
    if (html.includes("You are already logged in to an account. Please log out and try again.")) {
      throw "already logged in.";
    }
    console.log(html);
    return new DomParser().parseFromString(html, "text/html")
      .getElementById("new_user") //Get the form
      .childNodes[0].getAttribute('value') //Get the hidden element and it's value
  } catch (e) {
    console.error("An error occurred while running fetchLoginAuthenticityToken", e);
    throw e;
  }
}

//Cloudflare uses these to turn away automated clients.
const CLOUDFLARE_STATUSES = [403, 503, 520, 522, 525, 418];

//AO3 runs Rails with per-form CSRF tokens: a work page carries three different
//authenticity_token values and each is bound to the session that minted it, so
//the token and the POST must come from the same session.
//
//Which transport satisfies that depends on the platform. On Android React
//Native's fetch and the WebView share one cookie jar (ForwardingCookieHandler
//over android.webkit.CookieManager), so a token minted in the WebView is still
//valid for the POST - and going through getUrl keeps the Cloudflare fallback
//that a bare fetch would lose. On iOS WKWebView keeps its own store and nothing
//syncs it back to the jar NSURLSession uses, so a WebView-minted token would be
//spent in a different session; there the token has to come from the same native
//transport that sends the kudo.
async function getWorkPage(workId) {
  const url = `https://archiveofourown.org/works/${workId}?view_adult=true`;

  if (Platform.OS === 'android') {
    return getUrl(url);
  }

  const response = await fetch(url, {
    credentials: 'include',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'User-Agent': BROWSER_UA,
    },
  });

  if (!response.ok) {
    //A Cloudflare challenge here means native requests are being blocked, and
    //the kudo POST is a native request too, so there is nothing to fall back
    //to - say so plainly instead of reporting a bare status code.
    if (CLOUDFLARE_STATUSES.includes(response.status)) {
      throw new Error(
        `AO3 is blocking requests right now (${response.status}). Try again in a few minutes.`,
      );
    }
    throw new Error(
      `Could not load the work page: ${response.status} ${response.statusText}`,
    );
  }

  return response.text();
}

//AO3 full-page-caches logged-out responses and repairs the stale CSRF tokens in
//the browser afterwards, from this endpoint. It hands back the GLOBAL masked
//token, which Rails accepts for any action, so it is also the right fallback
//whenever the page we got is a cached/logged-out one.
async function fetchDispenserToken() {
  const response = await fetch(
    'https://archiveofourown.org/token_dispenser.json',
    {
      credentials: 'include',
      headers: { Accept: 'application/json', 'User-Agent': BROWSER_UA },
    },
  );

  if (!response.ok) {
    throw new Error(
      `token_dispenser failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.json();
  if (!data?.token) {
    throw new Error('token_dispenser returned no token.');
  }
  return data.token;
}

export async function fetchKudoAuthenticityToken(workId) {
  try {
    const html = await getWorkPage(workId);

    //A page served with the logged-out login box is AO3's cached copy; its
    //embedded tokens are stale by design and only the dispenser is current.
    if (html.includes('id="small_login"')) {
      console.log('Work page came back logged-out/cached, using the dispenser.');
      return await fetchDispenserToken();
    }

    //Scope strictly to the kudo form. The other authenticity_token values on a
    //work page belong to the login and comment forms, and per-form tokens are
    //not interchangeable, so a whole-page scan would send one Rails rejects.
    const kudoFormMatch = html.match(
      /<form[^>]*id="new_kudo"[\s\S]*?<\/form>/i,
    );

    const token =
      kudoFormMatch &&
      (kudoFormMatch[0].match(
        /name="authenticity_token"[^>]*?value="([^"]+)"/i,
      ) ||
        kudoFormMatch[0].match(
          /value="([^"]+)"[^>]*?name="authenticity_token"/i,
        ));

    if (token) {
      return token[1];
    }

    //No kudo form. Rather than fail outright, fall back to the global token,
    //which is valid for POST /kudos too.
    console.log('No kudo form on the work page, using the dispenser.');
    return await fetchDispenserToken();

  } catch (e) {
    console.error("An error occurred while running fetchKudoAuthenticityToken", e);
    throw e; // Re-throw to allow caller to handle
  }
}
