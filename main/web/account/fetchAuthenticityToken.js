import ky from 'ky';

let DomParser = require('react-native-html-parser').DOMParser;

export async function fetchLoginAuthenticityToken() {
  try {
    let html = await ky.get("https://archiveofourown.org/users/login").text();
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

//Browser UA, same as every other request the app makes, so Cloudflare treats
//this like the rest of the session.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

//AO3 runs Rails with per-form CSRF tokens: a work page carries three different
//authenticity_token values and each is bound to the session that minted it.
//That makes the TRANSPORT load bearing. getUrl() switches to the WKWebView for
//24h once Cloudflare mode trips, and the WebView has its own cookie jar that
//nothing syncs back, so a token minted there is worthless to the native fetch()
//that sends the kudo. Both legs therefore go through plain fetch() here.
async function getWorkPage(workId) {
  const response = await fetch(
    `https://archiveofourown.org/works/${workId}?view_adult=true`,
    {
      credentials: 'include',
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'User-Agent': BROWSER_UA,
      },
    },
  );

  if (!response.ok) {
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
