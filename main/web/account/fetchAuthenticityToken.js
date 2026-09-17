import ky from 'ky';
import getUrl from '../requestManager';

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

export async function fetchKudoAuthenticityToken(workId) {
  try {
    //https, not http: iOS App Transport Security refuses cleartext requests
    //outright, so the old http:// url could never load and every kudo failed.
    //view_adult=true, or explicit works answer with the "this work could have
    //adult content" interstitial, which carries no kudo form.
    const html = await getUrl(
      `https://archiveofourown.org/works/${workId}?view_adult=true`,
    );

    //Same trick as markForLater, the parser trips over AO3's markup often
    //enough that matching the input directly is simply more reliable.
    const kudoFormMatch = html.match(
      /<form[^>]*id="new_kudo"[\s\S]*?<\/form>/i,
    );

    const scope = kudoFormMatch ? kudoFormMatch[0] : html;
    const token =
      scope.match(/name="authenticity_token"[^>]*?value="([^"]+)"/i) ||
      scope.match(/value="([^"]+)"[^>]*?name="authenticity_token"/i);

    if (!token) {
      if (html.includes('This work could have adult content')) {
        throw new Error('Could not load the work page (adult content gate).');
      }
      throw new Error('Authenticity token not found on the work page.');
    }

    return token[1];

  } catch (e) {
    console.error("An error occurred while running fetchKudoAuthenticityToken", e);
    throw e; // Re-throw to allow caller to handle
  }
}
